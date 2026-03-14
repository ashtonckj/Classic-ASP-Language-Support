/**
 * cssDiagnosticsProvider.ts
 * Provides CSS validation diagnostics (errors and warnings) inside <style> blocks in .asp files using vscode-css-languageservice.
 * Runs on every document change and on open/close.
 */

import * as vscode from 'vscode';
import { getCSSLanguageService, DiagnosticSeverity as LsSeverity } from 'vscode-css-languageservice';
import { buildCssDoc, getZone } from '../utils/cssUtils';

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

    const content = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // Scan through all <style> blocks in the document
    let searchFrom = 0;
    while (true) {
        const styleOpen = content.indexOf('<style', searchFrom);
        if (styleOpen === -1) break;

        // Skip <style text that appears inside an HTML comment (<!-- ... -->),
        // a <script> block, or an ASP block (<% ... %>).
        // getZone returns 'html' only for genuine top-level HTML markup.
        // The HTML comment check must be explicit because getZone returns 'html'
        // for comment content too (comments are not a distinct zone).
        if (isInsideHtmlComment(content, styleOpen) || getZone(content, styleOpen) !== 'html') {
            searchFrom = styleOpen + 6;
            continue;
        }

        const styleTagEnd = content.indexOf('>', styleOpen);
        if (styleTagEnd === -1) break;

        const styleClose = content.indexOf('</style>', styleTagEnd);
        const cssStart = styleTagEnd + 1;

        const lsDoc = buildCssDoc(
            document.uri.toString(),
            content,
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