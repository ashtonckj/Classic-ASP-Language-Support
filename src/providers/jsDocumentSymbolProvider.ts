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
 *
 * The TS AST is built from the virtual content (preamble + body), so every
 * node offset has preambleLength taken off before it reaches
 * document.positionAt / makeSymbol; otherwise each Outline entry would point
 * that many characters too far down the page.
 */

import * as vscode from 'vscode';
import type * as TS from 'typescript';
import {
    buildVirtualJsContent,
    VIRTUAL_FILENAME,
} from '../utils/jsUtils';
import { getJsBlockRanges } from '../utils/zoneUtils';

// TypeScript, loaded by provideDocumentSymbols on the first page that has a
// <script> block rather than when this module is: a page without one has no
// JavaScript to outline, and TypeScript takes ~190 ms to load.
let ts!: typeof TS;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatParams(node: TS.FunctionLike): string {
    return node.parameters.map(p => p.name.getText()).join(', ');
}

/**
 * Creates a DocumentSymbol whose range and selectionRange are expressed in
 * document-space offsets (NOT virtual-file-space offsets).
 *
 * Returns undefined when there is no name to show, which the callers must skip.
 * vscode.DocumentSymbol rejects an empty name outright ("name must not be
 * falsy"), and TypeScript hands us one routinely: its error recovery inserts a
 * MISSING identifier while a declaration is still being typed, so `function(`
 * parses as a FunctionDeclaration whose `name` node EXISTS but whose text is
 * empty. A `node.name` truthiness check passes, and the constructor then threw
 * on every keystroke until the name was finished — taking the whole Outline with
 * it. Returning undefined puts that invariant in the type system rather than
 * leaving it to each guard.
 *
 * @param preambleLength  Must be subtracted from every raw TS AST offset.
 */
function makeSymbol(
    document:       vscode.TextDocument,
    name:           string,
    detail:         string,
    kind:           vscode.SymbolKind,
    startOffset:    number,
    endOffset:      number,
    nameOffset:     number,
    preambleLength: number,
): vscode.DocumentSymbol | undefined {
    if (!name) { return undefined; }

    // From the virtual file's offsets to the page's.
    const docStart    = startOffset - preambleLength;
    const docEnd      = endOffset   - preambleLength;
    const docNameStart = nameOffset  - preambleLength;

    const range    = new vscode.Range(document.positionAt(docStart), document.positionAt(docEnd));
    const selRange = new vscode.Range(document.positionAt(docNameStart), document.positionAt(docNameStart + name.length));
    return new vscode.DocumentSymbol(name, detail, kind, range, selRange);
}

/** Appends a symbol only when makeSymbol produced one. */
function pushIfNamed(
    into:   vscode.DocumentSymbol[],
    symbol: vscode.DocumentSymbol | undefined,
): void {
    if (symbol) { into.push(symbol); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Derive a human-readable name for a call-expression callback, matching the
// format VS Code's HTML provider uses:
//   .forEach(textarea => …)       → "forEach(textarea) callback"
//   .addEventListener('input', …) → "addEventListener('input') callback"
//   .then(result => …)            → "then(result) callback"
// ─────────────────────────────────────────────────────────────────────────────
function callbackLabel(
    call:      TS.CallExpression,
    cbArgIdx:  number,
    sourceFile: TS.SourceFile,
): { callee: string; hint: string } {
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

// ─────────────────────────────────────────────────────────────────────────────
// Full recursive AST walker — all offsets passed in/out are virtual-file-space.
// The preambleLength adjustment is applied only inside makeSymbol.
// ─────────────────────────────────────────────────────────────────────────────

function walkNode(
    node:           TS.Node,
    document:       vscode.TextDocument,
    sourceFile:     TS.SourceFile,
    rangeStart:     number,   // virtual-file-space JS range start
    rangeEnd:       number,   // virtual-file-space JS range end
    depth:          number,
    preambleLength: number,
): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];

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
            preambleLength,
        );
        if (!sym) { return result; }
        if (node.body) {
            for (const stmt of node.body.statements) {
                sym.children.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1, preambleLength));
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
            preambleLength,
        );
        if (!sym) { return result; }

        for (const member of node.members) {
            if (ts.isMethodDeclaration(member) && member.name) {
                const mSym = makeSymbol(
                    document, (member.name as TS.Identifier).text,
                    `(${formatParams(member)})`,
                    vscode.SymbolKind.Method,
                    member.getStart(sourceFile), member.getEnd(),
                    member.name.getStart(sourceFile),
                    preambleLength,
                );
                if (!mSym) { continue; }
                if (member.body) {
                    for (const stmt of member.body.statements) {
                        mSym.children.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1, preambleLength));
                    }
                }
                sym.children.push(mSym);
            } else if (ts.isConstructorDeclaration(member)) {
                const cSym = makeSymbol(
                    document, 'constructor',
                    `(${formatParams(member)})`,
                    vscode.SymbolKind.Constructor,
                    member.getStart(sourceFile), member.getEnd(),
                    member.getStart(sourceFile),
                    preambleLength,
                );
                if (cSym) { sym.children.push(cSym); }
            } else if (ts.isPropertyDeclaration(member) && member.name) {
                const pSym = makeSymbol(
                    document, (member.name as TS.Identifier).text, '',
                    vscode.SymbolKind.Property,
                    member.getStart(sourceFile), member.getEnd(),
                    member.name.getStart(sourceFile),
                    preambleLength,
                );
                if (pSym) { sym.children.push(pSym); }
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
                    preambleLength,
                );
                if (!sym) { continue; }

                const body = ts.isArrowFunction(init)
                    ? (ts.isBlock(init.body) ? init.body : undefined)
                    : init.body;
                if (body) {
                    for (const stmt of body.statements) {
                        sym.children.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1, preambleLength));
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
                pushIfNamed(result, makeSymbol(
                    document, name,
                    initText.length > 40 ? initText.slice(0, 40) + '…' : initText,
                    isConst ? vscode.SymbolKind.Constant : vscode.SymbolKind.Variable,
                    nodeStart, nodeEnd,
                    decl.name.getStart(sourceFile),
                    preambleLength,
                ));
            }
        }
        return result;
    }

    // ── expression statement — look for call-expression chains with callbacks ─
    if (ts.isExpressionStatement(node)) {
        result.push(...walkCallChain(node.expression, document, sourceFile, rangeStart, rangeEnd, depth, preambleLength));
        return result;
    }

    // ── other block-level constructs (if/for/while/try etc.) ─────────────────
    ts.forEachChild(node, child => {
        if (ts.isBlock(child)) {
            for (const stmt of child.statements) {
                result.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1, preambleLength));
            }
        }
    });

    return result;
}

function walkCallChain(
    expr:           TS.Expression,
    document:       vscode.TextDocument,
    sourceFile:     TS.SourceFile,
    rangeStart:     number,
    rangeEnd:       number,
    depth:          number,
    preambleLength: number,
): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];

    if (!ts.isCallExpression(expr)) { return result; }

    if (ts.isCallExpression(expr.expression) ||
        (ts.isPropertyAccessExpression(expr.expression) && ts.isCallExpression(expr.expression.expression))) {
        const inner = ts.isPropertyAccessExpression(expr.expression)
            ? expr.expression.expression
            : expr.expression;
        result.push(...walkCallChain(inner, document, sourceFile, rangeStart, rangeEnd, depth, preambleLength));
    }

    expr.arguments.forEach((arg, argIdx) => {
        if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) { return; }

        const argStart = arg.getStart(sourceFile);
        const argEnd   = arg.getEnd();
        if (argStart < rangeStart || argEnd > rangeEnd) { return; }

        const { callee, hint } = callbackLabel(expr, argIdx, sourceFile);
        const isAsync = !!(arg.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
        const params  = formatParams(arg);

        const name   = hint ? `${callee}(${hint}) callback` : `${callee}() callback`;
        const detail = `${isAsync ? 'async ' : ''}(${params})`;

        const sym = makeSymbol(
            document, name, detail,
            vscode.SymbolKind.Function,
            argStart, argEnd,
            argStart,
            preambleLength,
        );

        if (!sym) { return; }

        const body = ts.isArrowFunction(arg)
            ? (ts.isBlock(arg.body) ? arg.body : undefined)
            : arg.body;
        if (body) {
            for (const stmt of body.statements) {
                sym.children.push(...walkNode(stmt, document, sourceFile, rangeStart, rangeEnd, depth + 1, preambleLength));
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
    document:       vscode.TextDocument,
    sourceFile:     TS.SourceFile,
    nodes:          TS.NodeArray<TS.Statement>,
    rangeStart:     number,
    rangeEnd:       number,
    preambleLength: number,
): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];
    for (const node of nodes) {
        result.push(...walkNode(node, document, sourceFile, rangeStart, rangeEnd, 0, preambleLength));
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

        const fullText = document.getText();

        // The same block scan getZone uses, so the Outline and the rest of the
        // extension agree about where every <script> ends.
        const jsRanges = getJsBlockRanges(fullText);
        if (jsRanges.length === 0 || token.isCancellationRequested) { return []; }

        ts ??= require('typescript') as typeof TS;

        const { virtualContent, preambleLength } = buildVirtualJsContent(fullText, 0);

        // Only the syntax tree is needed — no types — so the script is parsed
        // on its own, the way the language service parses it. Asking the
        // service for its program instead rebuilt the program that hover and
        // completion share, on every edit.
        const sourceFile = ts.createSourceFile(
            VIRTUAL_FILENAME, virtualContent, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS,
        );
        if (token.isCancellationRequested) { return []; }

        // The TS AST node positions are in virtual-file space.
        // We shift the JS range boundaries into virtual-file space too so that
        // the range guard (nodeStart < rangeStart) works correctly, then pass
        // preambleLength down into makeSymbol for the final document.positionAt call.
        //
        // The walk runs over a half-typed document on every keystroke, against an
        // AST full of TypeScript's error-recovery nodes. Anything unexpected in
        // there should cost the Outline for one keystroke, not throw out of the
        // provider — an exception here is reported by VS Code as an extension
        // error, and under a debug session it stops the Extension Host dead.
        const result: vscode.DocumentSymbol[] = [];
        try {
            for (const range of jsRanges) {
                if (token.isCancellationRequested) { break; }
                // Into the virtual file's offsets, which the AST uses.
                const virtualRangeStart = range.start + preambleLength;
                const virtualRangeEnd   = range.end   + preambleLength;
                result.push(...collectSymbols(
                    document, sourceFile, sourceFile.statements,
                    virtualRangeStart, virtualRangeEnd,
                    preambleLength,
                ));
            }
        } catch (err) {
            console.error('[ASP] JS document symbols failed:', err);
            return [];
        }

        result.sort((a, b) => a.range.start.line - b.range.start.line);
        return result;
    }
}