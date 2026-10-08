/**
 * cssDiagnosticsProvider.ts
 * Provides CSS validation diagnostics (errors and warnings) inside <style> blocks
 * and style="" attributes in .asp files using vscode-css-languageservice.
 * Runs on every document change and on open/close.
 */

import * as vscode from 'vscode';
import type { DiagnosticSeverity as LsSeverity } from 'vscode-css-languageservice';
import { CHECK_DELAY, createAspDiagnosticCollection, cssCode, makeDiagnostic, watchAspDocuments } from '../platform/diagnostics';
import { buildInlineCssDoc, cssLanguageService, cssLanguageServiceModule, inlinePageOffset, inlineStyleValues } from './cssUtils';
import { getParsedCssBlocks, pagePosition } from './cssPageStylesheet';
import { textOf, zonesFor } from '../platform/documentState';

/** The CSS service's code for a problem (a string, a number or { value }), as one of ours. */
function codeOf(d: { code?: unknown }): `css-${string}` {
    const value = typeof d.code === 'object' && d.code !== null ? (d.code as { value: string | number }).value : d.code;
    return cssCode(typeof value === 'string' || typeof value === 'number' ? value : 'validation');
}

function mapSeverity(severity: LsSeverity | undefined): vscode.DiagnosticSeverity {
    const { DiagnosticSeverity: LsSeverity } = cssLanguageServiceModule();
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
 * Used to skip a style attribute inside a comment, because a comment's inside
 * is in the 'html' zone (comments are not a zone of their own), so the zone
 * check alone is not enough.
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

    const fullText = textOf(document);
    const diagnostics: vscode.Diagnostic[] = [];

    // The zone map's <style> blocks: real ones only, not one inside an HTML
    // comment, a <% %> block, another tag's attribute or a script's string.
    const zones = zonesFor(document);
    const blockRanges = zones.cssBlocks;

    // Each block's document holds only that block, so the language service
    // reports positions relative to it; pagePosition shifts them back.
    for (const block of getParsedCssBlocks(document.uri.toString(), fullText, document.version, blockRanges)) {
        const blockStart = document.positionAt(block.range.start);

        for (const d of cssLanguageService().doValidation(block.cssDoc, block.stylesheet)) {
            const s = pagePosition(blockStart, d.range.start);
            const e = pagePosition(blockStart, d.range.end);

            diagnostics.push(makeDiagnostic(
                new vscode.Range(
                    new vscode.Position(s.line, s.character),
                    new vscode.Position(e.line, e.character),
                ),
                d.message,
                mapSeverity(d.severity),
                codeOf(d),
            ));
        }
    }

    // ── Inline style="" attribute validation ─────────────────────────────────
    for (const value of inlineStyleValues(fullText)) {
        // Only a real HTML attribute is validated: a style attribute written in
        // a JavaScript string — `var tpl = '<div style="colour: red">x</div>'` —
        // or in a VBScript one is text there, and warning about it would be
        // warning about a string literal. The inside of an HTML comment is in
        // the markup zone, so it is ruled out on its own.
        if (zones.zoneAt(value.valueStart) !== 'html') { continue; }
        if (isInsideHtmlComment(fullText, value.valueStart)) { continue; }

        const lsDoc = buildInlineCssDoc(document.uri.toString(), fullText, document.version, value.valueStart, value.valueEnd);
        const stylesheet = cssLanguageService().parseStylesheet(lsDoc);

        for (const d of cssLanguageService().doValidation(lsDoc, stylesheet)) {
            // Back from the virtual "* { … }" document to the page.
            const start = inlinePageOffset(value.valueStart, lsDoc.offsetAt(d.range.start));
            const end   = Math.min(inlinePageOffset(value.valueStart, lsDoc.offsetAt(d.range.end)), value.valueEnd);
            if (start < value.valueStart) { continue; }

            diagnostics.push(makeDiagnostic(
                new vscode.Range(document.positionAt(start), document.positionAt(Math.max(start, end))),
                d.message, mapSeverity(d.severity), codeOf(d),
            ));
        }
    }

    collection.set(document.uri, diagnostics);
}

export function registerCssDiagnostics(context: vscode.ExtensionContext): void {
    const collection = createAspDiagnosticCollection('classic-asp-css');
    context.subscriptions.push(collection);

    // A burst of keystrokes re-parses the <style> blocks once, not once per
    // character; a page just opened is checked at once.
    watchAspDocuments(context, {
        delay: CHECK_DELAY.css,
        check: document => validateDocument(document, collection),
        checkOnOpen: true,
        collections: [collection],
    });
}