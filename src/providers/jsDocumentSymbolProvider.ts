/**
 * jsDocumentSymbolProvider.ts  (providers/)
 *
 * Document symbols for JavaScript inside <script> blocks in .asp files.
 * Populates the VS Code Outline panel and breadcrumb bar with JS-specific
 * symbols — functions, classes, and top-level const/let/var declarations.
 *
 * Complements aspDocumentSymbolProvider.ts which covers VBScript symbols.
 * Both providers are registered against 'asp' in extension.ts and VS Code
 * merges their results, displaying them sorted by line number in the outline.
 *
 * Symbol types emitted:
 *   • Function declarations          function foo() {}
 *   • Arrow functions assigned       const foo = () => {}  /  const foo = async () => {}
 *   • Function expressions assigned  const foo = function() {}
 *   • Class declarations             class Foo {}
 *   • Top-level const/let/var        const API_URL = '...'   (scalars only, not objects/arrays)
 *
 * Uses the TypeScript Language Service (via getJsLanguageService) to walk the
 * real AST rather than regex-matching, so nested functions, arrow functions
 * with implicit returns, and other edge cases are handled correctly.
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

/** Build a parameter list string from a TS function-like node. */
function formatParams(node: ts.FunctionLike): string {
    return node.parameters
        .map(p => p.name.getText())
        .join(', ');
}

/**
 * Convert a TS SourceFile position (character offset) to a vscode.Position.
 * We use the document's positionAt so line endings are handled correctly.
 */
function pos(document: vscode.TextDocument, offset: number): vscode.Position {
    return document.positionAt(offset);
}

/**
 * Build a DocumentSymbol whose full range covers [startOffset, endOffset]
 * and whose selection range highlights just the name identifier.
 */
function makeSymbol(
    document:    vscode.TextDocument,
    name:        string,
    detail:      string,
    kind:        vscode.SymbolKind,
    startOffset: number,
    endOffset:   number,
    nameOffset:  number,
): vscode.DocumentSymbol {
    const range     = new vscode.Range(pos(document, startOffset), pos(document, endOffset));
    const selStart  = pos(document, nameOffset);
    const selEnd    = pos(document, nameOffset + name.length);
    return new vscode.DocumentSymbol(name, detail, kind, range, new vscode.Range(selStart, selEnd));
}

// ─────────────────────────────────────────────────────────────────────────────
// AST walker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the TS AST and collect document symbols.
 * Only visits the top level of each script block — nested functions are added
 * as children of their parent symbol so the outline stays clean.
 */
function collectSymbols(
    document:    vscode.TextDocument,
    sourceFile:  ts.SourceFile,
    nodes:       ts.NodeArray<ts.Statement>,
    jsRangeStart: number,   // character offset where this script block begins
    jsRangeEnd:   number,   // character offset where this script block ends
): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];

    for (const node of nodes) {
        // Only emit symbols that actually fall inside a JS script block
        if (node.pos < jsRangeStart || node.end > jsRangeEnd) { continue; }

        // ── function declaration ───────────────────────────────────────────
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name    = node.name.text;
            const params  = formatParams(node);
            const isAsync = !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
            const detail  = `${isAsync ? 'async ' : ''}(${params})`;

            const sym = makeSymbol(
                document, name, detail,
                vscode.SymbolKind.Function,
                node.getStart(sourceFile),
                node.getEnd(),
                node.name.getStart(sourceFile),
            );

            // Recurse into the function body for nested named functions/classes
            if (node.body) {
                sym.children = collectSymbols(
                    document, sourceFile, node.body.statements,
                    jsRangeStart, jsRangeEnd
                );
            }
            result.push(sym);
            continue;
        }

        // ── class declaration ──────────────────────────────────────────────
        if (ts.isClassDeclaration(node) && node.name) {
            const name = node.name.text;
            const sym  = makeSymbol(
                document, name, '',
                vscode.SymbolKind.Class,
                node.getStart(sourceFile),
                node.getEnd(),
                node.name.getStart(sourceFile),
            );

            // Add class members as children
            for (const member of node.members) {
                if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member))
                    && 'name' in member && member.name) {
                    const mName   = ts.isConstructorDeclaration(member)
                        ? 'constructor'
                        : (member.name as ts.Identifier).text;
                    const mParams = formatParams(member as ts.FunctionLike);
                    sym.children.push(makeSymbol(
                        document, mName, `(${mParams})`,
                        vscode.SymbolKind.Method,
                        member.getStart(sourceFile),
                        member.getEnd(),
                        member.name
                            ? (member.name as ts.Node).getStart(sourceFile)
                            : member.getStart(sourceFile),
                    ));
                } else if (ts.isPropertyDeclaration(member) && member.name) {
                    const pName = (member.name as ts.Identifier).text;
                    sym.children.push(makeSymbol(
                        document, pName, '',
                        vscode.SymbolKind.Property,
                        member.getStart(sourceFile),
                        member.getEnd(),
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

                // ── assigned arrow function or function expression ─────────
                if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                    const isAsync = !!(init.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
                    const params  = formatParams(init);
                    const detail  = `${isAsync ? 'async ' : ''}(${params})`;

                    const sym = makeSymbol(
                        document, name, detail,
                        vscode.SymbolKind.Function,
                        node.getStart(sourceFile),
                        node.getEnd(),
                        decl.name.getStart(sourceFile),
                    );

                    // Recurse into the function body
                    const body = ts.isArrowFunction(init)
                        ? (ts.isBlock(init.body) ? init.body : undefined)
                        : init.body;
                    if (body) {
                        sym.children = collectSymbols(
                            document, sourceFile, body.statements,
                            jsRangeStart, jsRangeEnd
                        );
                    }
                    result.push(sym);
                    continue;
                }

                // ── plain scalar const/let/var ─────────────────────────────
                // Only show scalars (string, number, boolean literals) — skip
                // object literals, array literals, and call expressions to
                // avoid cluttering the outline with every variable.
                if (!init ||
                    ts.isStringLiteral(init)  ||
                    ts.isNumericLiteral(init) ||
                    (init.kind === ts.SyntaxKind.TrueKeyword)  ||
                    (init.kind === ts.SyntaxKind.FalseKeyword) ||
                    ts.isTemplateExpression(init)
                ) {
                    // Only emit top-level scalars (depth check: parent is SourceFile)
                    if (node.parent.kind !== ts.SyntaxKind.SourceFile) { continue; }

                    const isConst = !!(node.declarationList.flags & ts.NodeFlags.Const);
                    const keyword = isConst ? 'const' : (
                        node.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var'
                    );
                    const detail = init ? init.getText(sourceFile) : '';

                    result.push(makeSymbol(
                        document, name,
                        detail.length > 40 ? detail.slice(0, 40) + '…' : detail,
                        isConst ? vscode.SymbolKind.Constant : vscode.SymbolKind.Variable,
                        node.getStart(sourceFile),
                        node.getEnd(),
                        decl.name.getStart(sourceFile),
                    ));
                }
            }
            continue;
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

        // Find all JS ranges so we can (a) skip if there are none, and
        // (b) pass range boundaries to collectSymbols for filtering
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

        // Build the virtual JS content and get the TS source file
        const { virtualContent } = buildVirtualJsContent(content, 0);
        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        // Get the parsed AST directly from the language service program
        const program    = svc.getProgram();
        const sourceFile = program?.getSourceFile(VIRTUAL_FILENAME);
        if (!sourceFile || token.isCancellationRequested) { return []; }

        const result: vscode.DocumentSymbol[] = [];

        for (const range of jsRanges) {
            if (token.isCancellationRequested) { break; }
            const symbols = collectSymbols(
                document, sourceFile,
                sourceFile.statements,
                range.start, range.end,
            );
            result.push(...symbols);
        }

        // Sort by source order (multiple script blocks may interleave)
        result.sort((a, b) => a.range.start.line - b.range.start.line);
        return result;
    }
}