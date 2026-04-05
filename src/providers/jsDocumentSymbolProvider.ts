/**
 * jsDocumentSymbolProvider.ts  (providers/)
 *
 * Document symbols for JavaScript inside <script> blocks in .asp files.
 * Populates the VS Code Outline panel and breadcrumb bar with JS-specific
 * symbols — functions, classes, top-level const/let/var declarations, AND
 * anonymous callbacks passed to call expressions (forEach, addEventListener,
 * then, etc.) — matching the behaviour of VS Code's built-in HTML support.
 *
 * Complements aspDocumentSymbolProvider.ts which covers VBScript symbols.
 * Both providers are registered against 'asp' in extension.ts and VS Code
 * merges their results in source order.
 *
 * Symbol types emitted:
 *   • Named function declarations        function foo() {}
 *   • Arrow / function expressions       const foo = () => {}
 *   • Class declarations with members    class Foo { method() {} }
 *   • Top-level scalar const/let/var     const API_URL = 'https://...'
 *     (object/array initialisers are skipped to keep the outline clean)
 *   • Call-expression callbacks          forEach(cb), addEventListener('x', cb)
 *     Named as "<callee>(<arg-label>) callback" to mirror VS Code HTML behaviour
 */

import * as vscode from 'vscode';
import * as ts     from 'typescript';
import {
    buildVirtualJsContent,
    getJsLanguageService,
    VIRTUAL_FILENAME,
} from '../utils/jsUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatParams(node: ts.FunctionLike): string {
    return node.parameters.map(p => p.name.getText()).join(', ');
}

function makeSymbol(
    document:    vscode.TextDocument,
    name:        string,
    detail:      string,
    kind:        vscode.SymbolKind,
    startOffset: number,
    endOffset:   number,
    nameOffset:  number,
): vscode.DocumentSymbol {
    const range    = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
    const selRange = new vscode.Range(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length));
    return new vscode.DocumentSymbol(name, detail, kind, range, selRange);
}

// ─────────────────────────────────────────────────────────────────────────────
// Derive a human-readable name for a call-expression callback, matching the
// format VS Code's HTML provider uses:
//   .forEach(textarea => …)       → "forEach(textarea) callback"
//   .addEventListener('input', …) → "addEventListener('input') callback"
//   .then(result => …)            → "then(result) callback"
// ─────────────────────────────────────────────────────────────────────────────
function callbackLabel(
    call:      ts.CallExpression,
    cbArgIdx:  number,
    sourceFile: ts.SourceFile,
): { callee: string; hint: string } {
    // Callee name
    const expr = call.expression;
    let callee = 'callback';
    if (ts.isPropertyAccessExpression(expr)) {
        callee = expr.name.text;
    } else if (ts.isIdentifier(expr)) {
        callee = expr.text;
    }

    // For the hint, prefer the first non-function argument before the callback
    // (e.g. the event name string in addEventListener).
    let hint = '';
    for (let i = 0; i < cbArgIdx; i++) {
        const arg = call.arguments[i];
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            hint = `'${arg.text}'`;
            break;
        }
    }

    // Fall back to the callback's first parameter name
    if (!hint) {
        const cbArg = call.arguments[cbArgIdx];
        if (cbArg && (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg))) {
            const firstParam = cbArg.parameters[0];
            if (firstParam) { hint = firstParam.name.getText(sourceFile); }
        }
    }

    return { callee, hint };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full recursive AST walker — descends into:
//   • statement lists (function bodies, blocks)
//   • call expression arguments (callbacks)
//   • chained member call expressions (.forEach.addEventListener etc.)
// ─────────────────────────────────────────────────────────────────────────────

function walkNode(
    node:       ts.Node,
    document:   vscode.TextDocument,
    sourceFile: ts.SourceFile,
    rangeStart: number,
    rangeEnd:   number,
    depth:      number,
): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];

    // Guard: skip nodes outside the JS range
    const nodeStart = node.getStart(sourceFile);
    const nodeEnd   = node.getEnd();
    if (nodeStart < rangeStart || nodeEnd > rangeEnd) { return result; }

    // ── function declaration ─────────────────────────────────────────────────
    if (ts.isFunctionDeclaration(node) && node.name) {
        const isAsync = !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
        const sym     = makeSymbol(
            document, node.name.text,
            `${isAsync ? 'async ' : ''}(${formatParams(node)})`,
            vscode.SymbolKind.Function,
            nodeStart, nodeEnd,
            node.name.getStart(sourceFile),
        );
        if (node.body) {
            for (const stmt of node.body.statements) {
                sym.children.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1));
            }
        }
        result.push(sym);
        return result;
    }

    // ── class declaration ────────────────────────────────────────────────────
    if (ts.isClassDeclaration(node) && node.name) {
        const sym = makeSymbol(
            document, node.name.text, '',
            vscode.SymbolKind.Class,
            nodeStart, nodeEnd,
            node.name.getStart(sourceFile),
        );
        for (const member of node.members) {
            if (ts.isMethodDeclaration(member) && member.name) {
                const mSym = makeSymbol(
                    document, (member.name as ts.Identifier).text,
                    `(${formatParams(member)})`,
                    vscode.SymbolKind.Method,
                    member.getStart(sourceFile), member.getEnd(),
                    member.name.getStart(sourceFile),
                );
                if (member.body) {
                    for (const stmt of member.body.statements) {
                        mSym.children.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1));
                    }
                }
                sym.children.push(mSym);
            } else if (ts.isConstructorDeclaration(member)) {
                sym.children.push(makeSymbol(
                    document, 'constructor',
                    `(${formatParams(member)})`,
                    vscode.SymbolKind.Constructor,
                    member.getStart(sourceFile), member.getEnd(),
                    member.getStart(sourceFile),
                ));
            } else if (ts.isPropertyDeclaration(member) && member.name) {
                sym.children.push(makeSymbol(
                    document, (member.name as ts.Identifier).text, '',
                    vscode.SymbolKind.Property,
                    member.getStart(sourceFile), member.getEnd(),
                    member.name.getStart(sourceFile),
                ));
            }
        }
        result.push(sym);
        return result;
    }

    // ── variable statement: const/let/var ────────────────────────────────────
    if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name)) { continue; }

            const name = decl.name.text;
            const init = decl.initializer;

            if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                const isAsync = !!(init.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
                const sym     = makeSymbol(
                    document, name,
                    `${isAsync ? 'async ' : ''}(${formatParams(init)})`,
                    vscode.SymbolKind.Function,
                    nodeStart, nodeEnd,
                    decl.name.getStart(sourceFile),
                );
                const body = ts.isArrowFunction(init)
                    ? (ts.isBlock(init.body) ? init.body : undefined)
                    : init.body;
                if (body) {
                    for (const stmt of body.statements) {
                        sym.children.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1));
                    }
                }
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
                result.push(makeSymbol(
                    document, name,
                    initText.length > 40 ? initText.slice(0, 40) + '…' : initText,
                    isConst ? vscode.SymbolKind.Constant : vscode.SymbolKind.Variable,
                    nodeStart, nodeEnd,
                    decl.name.getStart(sourceFile),
                ));
            }
        }
        return result;
    }

    // ── expression statement — look for call-expression chains with callbacks ─
    if (ts.isExpressionStatement(node)) {
        result.push(...walkCallChain(node.expression, document, sourceFile, rangeStart, rangeEnd, depth));
        return result;
    }

    // ── other block-level constructs (if/for/while/try etc.) ─────────────────
    // Recurse into their child statements so we don't miss nested declarations
    // or callbacks inside control-flow bodies.
    ts.forEachChild(node, child => {
        if (ts.isBlock(child)) {
            for (const stmt of child.statements) {
                result.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1));
            }
        }
    });

    return result;
}

// Walk a (potentially chained) call expression and collect any function/arrow
// arguments as named callback symbols, recursing into their bodies.
//
// Handles chains like:
//   document.querySelectorAll(…).forEach(cb)
//   fetch(url).then(cb).catch(cb)
//   el.addEventListener('click', cb)
function walkCallChain(
    expr:       ts.Expression,
    document:   vscode.TextDocument,
    sourceFile: ts.SourceFile,
    rangeStart: number,
    rangeEnd:   number,
    depth:      number,
): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];

    if (!ts.isCallExpression(expr)) {
        // Could be a chained member access that ends in a non-call — nothing to do
        return result;
    }

    // First recurse into the callee side so chained calls (e.g. forEach → then)
    // produce symbols in document order.
    if (ts.isCallExpression(expr.expression) ||
        (ts.isPropertyAccessExpression(expr.expression) && ts.isCallExpression(expr.expression.expression))) {
        const inner = ts.isPropertyAccessExpression(expr.expression)
            ? expr.expression.expression
            : expr.expression;
        result.push(...walkCallChain(inner, document, sourceFile, rangeStart, rangeEnd, depth));
    }

    // Now check each argument of this call — if it is a function/arrow, emit it
    expr.arguments.forEach((arg, argIdx) => {
        if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) { return; }

        const argStart = arg.getStart(sourceFile);
        const argEnd   = arg.getEnd();
        if (argStart < rangeStart || argEnd > rangeEnd) { return; }

        const { callee, hint } = callbackLabel(expr, argIdx, sourceFile);
        const isAsync = !!(arg.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
        const params  = formatParams(arg);

        // Name mirrors VS Code HTML: "forEach(textarea) callback"
        const name   = hint ? `${callee}(${hint}) callback` : `${callee}() callback`;
        const detail = `${isAsync ? 'async ' : ''}(${params})`;

        const sym = makeSymbol(
            document, name, detail,
            vscode.SymbolKind.Function,
            argStart, argEnd,
            argStart,   // no distinct name token — point to the start of the fn
        );

        // Recurse into the callback body
        const body = ts.isArrowFunction(arg)
            ? (ts.isBlock(arg.body) ? arg.body : undefined)
            : arg.body;
        if (body) {
            for (const stmt of body.statements) {
                sym.children.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1));
            }
        }

        result.push(sym);
    });

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level entry: walk all statements in each JS range
// ─────────────────────────────────────────────────────────────────────────────

function collectSymbols(
    document:   vscode.TextDocument,
    sourceFile: ts.SourceFile,
    nodes:      ts.NodeArray<ts.Statement>,
    rangeStart: number,
    rangeEnd:   number,
): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];
    for (const node of nodes) {
        result.push(...walkNode(node, document, sourceFile, rangeStart, rangeEnd, 0));
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class JsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

    provideDocumentSymbols(
        document: vscode.TextDocument,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.DocumentSymbol[]> {

        if (document.languageId !== 'asp') { return []; }

        const content = document.getText();

        const jsRanges: Array<{ start: number; end: number }> = [];
        const scriptOpenRe = /<script(\s[^>]*)?>/gi;
        let m: RegExpExecArray | null;
        while ((m = scriptOpenRe.exec(content)) !== null) {
            const attrs  = m[1] ?? '';
            const tagEnd = m.index + m[0].length;
            const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
            if (typeMatch && !/javascript|module/i.test(typeMatch[1])) { continue; }
            if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs)) { continue; }
            const rest     = content.slice(tagEnd);
            const closeIdx = rest.search(/<\/script\s*>/i);
            const end      = closeIdx === -1 ? content.length : tagEnd + closeIdx;
            jsRanges.push({ start: tagEnd, end });
            scriptOpenRe.lastIndex = end;
        }

        if (jsRanges.length === 0 || token.isCancellationRequested) { return []; }

        const { virtualContent } = buildVirtualJsContent(content, 0);
        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        const program    = svc.getProgram();
        const sourceFile = program?.getSourceFile(VIRTUAL_FILENAME);
        if (!sourceFile || token.isCancellationRequested) { return []; }

        const result: vscode.DocumentSymbol[] = [];
        for (const range of jsRanges) {
            if (token.isCancellationRequested) { break; }
            result.push(...collectSymbols(document, sourceFile, sourceFile.statements, range.start, range.end));
        }

        result.sort((a, b) => a.range.start.line - b.range.start.line);
        return result;
    }
}