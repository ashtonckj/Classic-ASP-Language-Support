/**
 * jsOutline.ts  (js/)
 *
 * The Outline and breadcrumb entries for the JavaScript in a page's <script>
 * blocks — functions, classes, top-level const/let/var declarations, AND
 * anonymous callbacks passed to call expressions (forEach, addEventListener,
 * then, etc.) — matching the behaviour of VS Code's built-in HTML support.
 *
 * Symbol types emitted:
 *   • Named function declarations        function foo() {}
 *   • Arrow / function expressions       const foo = () => {}
 *   • Class declarations with members    class Foo { method() {} }
 *   • Top-level scalar const/let/var     const API_URL = 'https://...'
 *     (object/array initialisers are skipped to keep the outline clean)
 *   • Call-expression callbacks          forEach(cb), addEventListener('x', cb)
 *     Named as "<callee>(<arg-label>) callback" to mirror VS Code HTML behaviour
 *
 * vscode-free: the JS worker runs it on the syntax tree it has already parsed
 * for the colouring, so the Outline costs no parse of its own. Parsing the
 * script of an 8,000-line page took ~80 ms, after every edit, on the extension
 * host. Offsets in the result are the page's.
 */

import type * as TS from 'typescript';

export type JsOutlineKind = 'function' | 'class' | 'method' | 'constructor' | 'property' | 'constant' | 'variable';

export interface JsOutlineSymbol {
    name:      string;
    detail:    string;
    kind:      JsOutlineKind;
    /** The whole declaration, as page offsets. */
    start:     number;
    end:       number;
    /** Where the name is written; it runs for `name.length`. */
    nameStart: number;
    children:  JsOutlineSymbol[];
}

/**
 * The outline of the script in `sourceFile`, the virtual file built from the
 * page (jsUtils), whose first `preambleLength` characters are not the page's.
 * Only nodes inside one of `jsRanges` (page offsets) count.
 */
export function jsOutline(
    ts: typeof TS,
    sourceFile: TS.SourceFile,
    jsRanges: ReadonlyArray<{ start: number; end: number }>,
    preambleLength: number,
): JsOutlineSymbol[] {

    const formatParams = (node: TS.SignatureDeclarationBase) => node.parameters.map(p => p.name.getText(sourceFile)).join(', ');
    const isAsync = (node: { modifiers?: TS.NodeArray<TS.ModifierLike> }) =>
        !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);

    /**
     * A symbol from virtual-file offsets, or undefined when there is no name to
     * show. TypeScript's error recovery inserts a MISSING identifier while a
     * declaration is still being typed, so `function(` parses as a declaration
     * whose name exists but is empty, and VS Code rejects an empty name.
     */
    function symbol(name: string, detail: string, kind: JsOutlineKind, start: number, end: number, nameStart: number): JsOutlineSymbol | undefined {
        if (!name) { return undefined; }
        return {
            name, detail, kind,
            start: start - preambleLength, end: end - preambleLength, nameStart: nameStart - preambleLength,
            children: [],
        };
    }

    // ── Name for a call-expression callback, the way VS Code's HTML support names it:
    //   .forEach(textarea => …)       → "forEach(textarea) callback"
    //   .addEventListener('input', …) → "addEventListener('input') callback"
    //   .then(result => …)            → "then(result) callback"
    function callbackLabel(call: TS.CallExpression, cbArgIdx: number): { callee: string; hint: string } {
        const expr = call.expression;
        let callee = 'callback';
        if (ts.isPropertyAccessExpression(expr)) {
            callee = expr.name.text;
        } else if (ts.isIdentifier(expr)) {
            callee = expr.text;
        }

        let hint = '';
        for (let i = 0; i < cbArgIdx; i++) {
            const arg = call.arguments[i];
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
                hint = `'${arg.text}'`;
                break;
            }
        }

        if (!hint) {
            const cbArg = call.arguments[cbArgIdx];
            if (cbArg && (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg))) {
                const firstParam = cbArg.parameters[0];
                if (firstParam) { hint = firstParam.name.getText(sourceFile); }
            }
        }

        return { callee, hint };
    }

    /** The statements of a function body, walked into `parent`'s children. */
    function walkBody(parent: JsOutlineSymbol, body: TS.Block | undefined, rangeStart: number, rangeEnd: number): void {
        if (!body) { return; }
        for (const stmt of body.statements) { parent.children.push(...walkNode(stmt, rangeStart, rangeEnd)); }
    }

    // All offsets passed in/out are virtual-file offsets; `symbol` moves them to the page.
    function walkNode(node: TS.Node, rangeStart: number, rangeEnd: number): JsOutlineSymbol[] {
        const result: JsOutlineSymbol[] = [];

        const nodeStart = node.getStart(sourceFile);
        const nodeEnd   = node.getEnd();
        if (nodeStart < rangeStart || nodeEnd > rangeEnd) { return result; }

        // ── function declaration ─────────────────────────────────────────────
        if (ts.isFunctionDeclaration(node) && node.name) {
            const sym = symbol(node.name.text, `${isAsync(node) ? 'async ' : ''}(${formatParams(node)})`, 'function',
                nodeStart, nodeEnd, node.name.getStart(sourceFile));
            if (!sym) { return result; }
            walkBody(sym, node.body, rangeStart, rangeEnd);
            result.push(sym);
            return result;
        }

        // ── class declaration ────────────────────────────────────────────────
        if (ts.isClassDeclaration(node) && node.name) {
            const sym = symbol(node.name.text, '', 'class', nodeStart, nodeEnd, node.name.getStart(sourceFile));
            if (!sym) { return result; }

            for (const member of node.members) {
                if (ts.isMethodDeclaration(member) && member.name) {
                    const mSym = symbol((member.name as TS.Identifier).text, `(${formatParams(member)})`, 'method',
                        member.getStart(sourceFile), member.getEnd(), member.name.getStart(sourceFile));
                    if (!mSym) { continue; }
                    walkBody(mSym, member.body, rangeStart, rangeEnd);
                    sym.children.push(mSym);
                } else if (ts.isConstructorDeclaration(member)) {
                    const cSym = symbol('constructor', `(${formatParams(member)})`, 'constructor',
                        member.getStart(sourceFile), member.getEnd(), member.getStart(sourceFile));
                    if (cSym) { sym.children.push(cSym); }
                } else if (ts.isPropertyDeclaration(member) && member.name) {
                    const pSym = symbol((member.name as TS.Identifier).text, '', 'property',
                        member.getStart(sourceFile), member.getEnd(), member.name.getStart(sourceFile));
                    if (pSym) { sym.children.push(pSym); }
                }
            }
            result.push(sym);
            return result;
        }

        // ── variable statement: const/let/var ────────────────────────────────
        if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name)) { continue; }

                const name = decl.name.text;
                const init = decl.initializer;

                if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                    const sym = symbol(name, `${isAsync(init) ? 'async ' : ''}(${formatParams(init)})`, 'function',
                        nodeStart, nodeEnd, decl.name.getStart(sourceFile));
                    if (!sym) { continue; }
                    const body = ts.isArrowFunction(init) ? (ts.isBlock(init.body) ? init.body : undefined) : init.body;
                    walkBody(sym, body, rangeStart, rangeEnd);
                    result.push(sym);
                    continue;
                }

                // Only show top-level scalar initialisers
                const isScalar = !init
                    || ts.isStringLiteral(init)
                    || ts.isNumericLiteral(init)
                    || ts.isTemplateLiteral(init)
                    || init.kind === ts.SyntaxKind.TrueKeyword
                    || init.kind === ts.SyntaxKind.FalseKeyword;

                if (isScalar && node.parent.kind === ts.SyntaxKind.SourceFile) {
                    const isConst  = !!(node.declarationList.flags & ts.NodeFlags.Const);
                    const initText = init ? init.getText(sourceFile) : '';
                    const sym = symbol(name, initText.length > 40 ? initText.slice(0, 40) + '…' : initText,
                        isConst ? 'constant' : 'variable', nodeStart, nodeEnd, decl.name.getStart(sourceFile));
                    if (sym) { result.push(sym); }
                }
            }
            return result;
        }

        // ── expression statement — look for call-expression chains with callbacks
        if (ts.isExpressionStatement(node)) {
            result.push(...walkCallChain(node.expression, rangeStart, rangeEnd));
            return result;
        }

        // ── other block-level constructs (if/for/while/try etc.) ─────────────
        ts.forEachChild(node, child => {
            if (ts.isBlock(child)) {
                for (const stmt of child.statements) { result.push(...walkNode(stmt, rangeStart, rangeEnd)); }
            }
        });

        return result;
    }

    function walkCallChain(expr: TS.Expression, rangeStart: number, rangeEnd: number): JsOutlineSymbol[] {
        const result: JsOutlineSymbol[] = [];
        if (!ts.isCallExpression(expr)) { return result; }

        if (ts.isCallExpression(expr.expression) ||
            (ts.isPropertyAccessExpression(expr.expression) && ts.isCallExpression(expr.expression.expression))) {
            const inner = ts.isPropertyAccessExpression(expr.expression) ? expr.expression.expression : expr.expression;
            result.push(...walkCallChain(inner, rangeStart, rangeEnd));
        }

        expr.arguments.forEach((arg, argIdx) => {
            if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) { return; }

            const argStart = arg.getStart(sourceFile);
            const argEnd   = arg.getEnd();
            if (argStart < rangeStart || argEnd > rangeEnd) { return; }

            const { callee, hint } = callbackLabel(expr, argIdx);
            const name   = hint ? `${callee}(${hint}) callback` : `${callee}() callback`;
            const detail = `${isAsync(arg) ? 'async ' : ''}(${formatParams(arg)})`;

            const sym = symbol(name, detail, 'function', argStart, argEnd, argStart);
            if (!sym) { return; }
            const body = ts.isArrowFunction(arg) ? (ts.isBlock(arg.body) ? arg.body : undefined) : arg.body;
            walkBody(sym, body, rangeStart, rangeEnd);
            result.push(sym);
        });

        return result;
    }

    const result: JsOutlineSymbol[] = [];
    for (const range of jsRanges) {
        // Into the virtual file's offsets, which the tree uses.
        const rangeStart = range.start + preambleLength;
        const rangeEnd   = range.end   + preambleLength;
        for (const node of sourceFile.statements) { result.push(...walkNode(node, rangeStart, rangeEnd)); }
    }
    return result.sort((a, b) => a.start - b.start);
}
