/**
 * jsDocumentSymbolProvider.ts  (providers/)
 *
 * Document symbols for JavaScript inside <script> blocks in .asp files.
 * Populates the VS Code Outline panel and breadcrumb bar with JS-specific
 * symbols — functions, classes, and top-level const/let/var declarations.
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
// AST walker
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
        // getStart() strips leading trivia (whitespace/comments) to get the
        // real first token. node.pos includes trivia and would be 0 or deep
        // inside the blanked region for most nodes in a virtual file, causing
        // the range check to incorrectly exclude every symbol.
        const nodeStart = node.getStart(sourceFile);
        const nodeEnd   = node.getEnd();

        if (nodeStart < rangeStart || nodeEnd > rangeEnd) { continue; }

        // ── function declaration ───────────────────────────────────────────
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
                sym.children = collectSymbols(document, sourceFile, node.body.statements, rangeStart, rangeEnd);
            }
            result.push(sym);
            continue;
        }

        // ── class declaration ──────────────────────────────────────────────
        if (ts.isClassDeclaration(node) && node.name) {
            const sym = makeSymbol(
                document, node.name.text, '',
                vscode.SymbolKind.Class,
                nodeStart, nodeEnd,
                node.name.getStart(sourceFile),
            );
            for (const member of node.members) {
                if (ts.isMethodDeclaration(member) && member.name) {
                    sym.children.push(makeSymbol(
                        document, (member.name as ts.Identifier).text,
                        `(${formatParams(member)})`,
                        vscode.SymbolKind.Method,
                        member.getStart(sourceFile), member.getEnd(),
                        member.name.getStart(sourceFile),
                    ));
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
            continue;
        }

        // ── variable statement: const/let/var ─────────────────────────────
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
                        sym.children = collectSymbols(document, sourceFile, body.statements, rangeStart, rangeEnd);
                    }
                    result.push(sym);
                    continue;
                }

                // Only show top-level scalar initialisers — objects, arrays,
                // and call expressions are excluded to avoid cluttering the outline.
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
        }
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