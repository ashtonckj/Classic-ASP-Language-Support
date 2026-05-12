/**
 * cssDiagnosticsProvider.ts
 * Provides CSS validation diagnostics (errors and warnings) inside <style> blocks in .asp files using vscode-css-languageservice.
 * Runs on every document change and on open/close.
 */

import * as vscode from 'vscode';
import { getCSSLanguageService, DiagnosticSeverity as LsSeverity } from 'vscode-css-languageservice';
import { buildCssDoc, getZone, getInlineStyleContext, buildInlineCssDoc } from '../utils/cssUtils';

const cssService = getCSSLanguageService();

function mapSeverity(severity: LsSeverity | undefined): vscode.DiagnosticSeverity {
    switch (severity) {
        case LsSeverity.Error:       return vscode.DiagnosticSeverity.Error;
        case LsSeverity.Warning:     return vscode.DiagnosticSeverity.Warning;
        case LsSeverity.Hint:        return vscode.DiagnosticSeverity.Hint;
        case LsSeverity.Information: return vscode.DiagnosticSeverity.Information;
        default:                     return vscode.DiagnosticSeverity.Warning;
    }
}

/**
 * Returns true if `pos` falls inside an HTML comment (<!-- ... -->).
 * Used to skip <style> text that appears inside comment blocks.
 */
function isInsideHtmlComment(content: string, pos: number): boolean {
    let searchFrom = 0;
    while (true) {
        const commentOpen = content.indexOf('<!--', searchFrom);
        if (commentOpen === -1 || commentOpen >= pos) return false;
        const commentClose = content.indexOf('-->', commentOpen + 4);
        if (commentClose === -1) return true;  // unclosed comment — pos is inside it
        if (pos < commentClose + 3) return true;
        searchFrom = commentClose + 3;
    }
}

function validateDocument(
    document: vscode.TextDocument,
    collection: vscode.DiagnosticCollection
): void {
    if (document.languageId !== 'asp') {
        collection.delete(document.uri);
        return;
    }

    const fullText = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // Scan through all <style> blocks in the document
    let searchFrom = 0;
    while (true) {
        const styleOpen = fullText.indexOf('<style', searchFrom);
        if (styleOpen === -1) break;

        // Skip <style text that appears inside an HTML comment (<!-- ... -->),
        // a <script> block, or an ASP block (<% ... %>).
        // getZone returns 'html' only for genuine top-level HTML markup.
        // The HTML comment check must be explicit because getZone returns 'html'
        // for comment content too (comments are not a distinct zone).
        if (isInsideHtmlComment(fullText, styleOpen) || getZone(fullText, styleOpen) !== 'html') {
            searchFrom = styleOpen + 6;
            continue;
        }

        const styleTagEnd = fullText.indexOf('>', styleOpen);
        if (styleTagEnd === -1) break;

        const styleClose = fullText.indexOf('</style>', styleTagEnd);
        const cssStart = styleTagEnd + 1;

        const lsDoc = buildCssDoc(
            document.uri.toString(),
            fullText,
            document.version,
            cssStart + 1  // +1 so we're inside the block
        );

        if (lsDoc) {
            const stylesheet = cssService.parseStylesheet(lsDoc);
            const lsDiagnostics = cssService.doValidation(lsDoc, stylesheet);

            for (const d of lsDiagnostics) {
                const start = new vscode.Position(d.range.start.line, d.range.start.character);
                const end = new vscode.Position(d.range.end.line, d.range.end.character);

                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(start, end),
                    d.message,
                    mapSeverity(d.severity)
                );

                diagnostic.source = 'Classic ASP (CSS)';

                // Safely handle d.code which can be string, number, or { value, target }
                if (d.code !== undefined && d.code !== null) {
                    if (typeof d.code === 'object') {
                        const codeObj = d.code as { value: string | number };
                        diagnostic.code = String(codeObj.value);
                    } else {
                        diagnostic.code = String(d.code);
                    }
                }

                diagnostics.push(diagnostic);
            }
        }

        if (styleClose === -1) break;
        searchFrom = styleClose + 8;
    }

    // ── Inline style="" attribute validation ─────────────────────────────────
    // Scan every line for style="..." attributes and validate the declarations.
    for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
        const lineText   = document.lineAt(lineIdx).text;
        const lineOffset = document.offsetAt(new vscode.Position(lineIdx, 0));

        // Walk along the line looking for style=" occurrences
        let searchCol = 0;
        while (searchCol < lineText.length) {
            // Find next style= on this line
            const styleMatch = lineText.slice(searchCol).match(/\bstyle\s*=\s*(["'])/i);
            if (!styleMatch) break;

            const matchStart  = searchCol + styleMatch.index!;
            const quoteChar   = styleMatch[1];
            const valueStart  = matchStart + styleMatch[0].length;
            const valueEnd    = lineText.indexOf(quoteChar, valueStart);
            if (valueEnd === -1) break;

            const offset = lineOffset + valueStart;

            // Skip if inside an ASP block or a <style> tag
            const zone = getZone(fullText, offset);
            if (zone === 'css' || zone === 'asp') { searchCol = valueEnd + 1; continue; }

            const inlineCtx = getInlineStyleContext(fullText, offset);
            if (!inlineCtx) { searchCol = valueEnd + 1; continue; }

            const lsDoc = buildInlineCssDoc(
                document.uri.toString(),
                fullText,
                document.version,
                inlineCtx.valueStart,
                inlineCtx.valueEnd
            );
            const stylesheet   = cssService.parseStylesheet(lsDoc);
            const lsDiagnostics = cssService.doValidation(lsDoc, stylesheet);

            for (const d of lsDiagnostics) {
                // Remap positions from the virtual "* { ... }" doc back to the real line.
                // The virtual doc has a 5-char prefix ("* {  ") so subtract it, then
                // add back the real valueStart column.
                const WRAPPER_PREFIX = 5;
                const realCol = (d.range.start.character - WRAPPER_PREFIX) + (valueStart - lineOffset);
                if (realCol < 0) continue;

                const start = new vscode.Position(lineIdx, realCol);
                const end   = new vscode.Position(
                    lineIdx,
                    realCol + (d.range.end.character - d.range.start.character)
                );

                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(start, end),
                    d.message,
                    mapSeverity(d.severity)
                );
                diagnostic.source = 'Classic ASP (inline CSS)';
                if (d.code !== undefined && d.code !== null) {
                    diagnostic.code = typeof d.code === 'object'
                        ? String((d.code as { value: string | number }).value)
                        : String(d.code);
                }
                diagnostics.push(diagnostic);
            }

            searchCol = valueEnd + 1;
        }
    }

    collection.set(document.uri, diagnostics);
}

export function registerCssDiagnostics(context: vscode.ExtensionContext): void {
    const collection = vscode.languages.createDiagnosticCollection('classic-asp-css');
    context.subscriptions.push(collection);

    // Validate all already-open .asp documents on activation
    for (const document of vscode.workspace.textDocuments) {
        validateDocument(document, collection);
    }

    // Validate as you type
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            validateDocument(e.document, collection);
        })
    );

    // Validate when a new document is opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            validateDocument(document, collection);
        })
    );

    // Clear diagnostics when document is closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            collection.delete(document.uri);
        })
    );
}