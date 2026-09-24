/**
 * cssDiagnosticsProvider.ts
 * Provides CSS validation diagnostics (errors and warnings) inside <style> blocks in .asp files using vscode-css-languageservice.
 * Runs on every document change and on open/close.
 */

import * as vscode from 'vscode';
import type { DiagnosticSeverity as LsSeverity } from 'vscode-css-languageservice';
import { getInlineStyleContext, buildInlineCssDoc, cssLanguageService, cssLanguageServiceModule } from '../utils/cssUtils';
import { getParsedCssBlocks, pagePosition } from '../utils/cssPageStylesheet';
import { createZoneResolver, findNextRealTag, findTagEnd, findClosingTag } from '../utils/zoneUtils';

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
 * Used to skip <style>/<script> text that appears inside comment blocks,
 * because getZone returns 'html' for comment interiors (comments are not
 * a distinct zone) so the zone check alone is not enough.
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

    // getZone answers about one offset by rescanning the document from the top.
    // It used to be called once per <style> block and once per style="" attribute,
    // so a page with many of either rescanned itself once for each. This builds
    // the zone map once and answers from it; zoneResolver.test.ts asserts the two
    // agree at every offset of a document.
    const zones = createZoneResolver(fullText);

    // Every <style> body worth validating, collected first so the whole page can
    // be built and parsed once instead of once per block.
    const blockRanges: Array<{ start: number; end: number }> = [];

    // Scan through all <style> blocks in the document. findNextRealTag skips a
    // <style that appears inside an HTML comment, an ASP block, or another tag's
    // attribute value, and matches case-insensitively.
    let searchFrom = 0;
    while (true) {
        const styleOpen = findNextRealTag(fullText, '<style', searchFrom);
        if (styleOpen === -1) break;

        // Locate the tag end and matching close the SAME way as getZone/buildCssDoc
        // (skipping ASP blocks + quoted attribute values, case-insensitive close),
        // so the probe offset below lands inside the real CSS body. Using a naive
        // indexOf('>') here previously produced a probe <= the real tag end, which
        // made buildCssDoc return null and silently dropped diagnostics for any
        // <style> whose opening tag contained a '>' (e.g. type="<%= x %>").
        const styleTagEnd = findTagEnd(fullText, styleOpen);
        if (styleTagEnd === -1) break;
        const { index: styleClose, length: closeLen } = findClosingTag(fullText, 'style', styleTagEnd + 1);
        const advance = styleClose === -1 ? fullText.length : styleClose + closeLen;

        // findNextRealTag does not model <script> rawtext, so a <style> literal
        // inside a <script> block could still match; the zone guard rejects it.
        // (getZone returns 'html' for comment interiors, so keep the explicit
        // comment check too.)
        if (isInsideHtmlComment(fullText, styleOpen) || zones.zoneAt(styleOpen) !== 'html') {
            searchFrom = advance;
            continue;
        }

        blockRanges.push({
            start: styleTagEnd + 1,
            end: styleClose === -1 ? fullText.length : styleClose,
        });

        if (styleClose === -1) break;
        searchFrom = advance;
    }

    // Each block's document holds only that block, so the language service
    // reports positions relative to it; pagePosition shifts them back.
    for (const block of getParsedCssBlocks(document.uri.toString(), fullText, document.version, blockRanges)) {
        const blockStart = document.positionAt(block.range.start);

        for (const d of cssLanguageService().doValidation(block.cssDoc, block.stylesheet)) {
            const s = pagePosition(blockStart, d.range.start);
            const e = pagePosition(blockStart, d.range.end);

            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(
                    new vscode.Position(s.line, s.character),
                    new vscode.Position(e.line, e.character),
                ),
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

            // Only a real HTML attribute is validated. Excluding just 'css' and
            // 'asp' left zone 'js' through, so a style attribute written inside a
            // JavaScript string — `var tpl = '<div style="colour: red">x</div>'` —
            // was pulled out and validated as CSS, warning about a string literal.
            // getZone returns 'html' for comment interiors, so the comment check
            // below is still needed.
            if (zones.zoneAt(offset) !== 'html') { searchCol = valueEnd + 1; continue; }
            if (isInsideHtmlComment(fullText, offset)) { searchCol = valueEnd + 1; continue; }

            const inlineCtx = getInlineStyleContext(fullText, offset);
            if (!inlineCtx) { searchCol = valueEnd + 1; continue; }

            const lsDoc = buildInlineCssDoc(
                document.uri.toString(),
                fullText,
                document.version,
                inlineCtx.valueStart,
                inlineCtx.valueEnd
            );
            const stylesheet   = cssLanguageService().parseStylesheet(lsDoc);
            const lsDiagnostics = cssLanguageService().doValidation(lsDoc, stylesheet);

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

    // Debounce validation so a burst of keystrokes triggers a single re-parse of
    // the document's <style> blocks instead of one per character (it used to run
    // synchronously on every change). Keyed by document URI, so editing one file
    // never cancels another file's pending scan.
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const DEBOUNCE_MS = 400;

    function scheduleValidation(document: vscode.TextDocument): void {
        // onDidChangeTextDocument fires for every document in the window, so
        // without this an edit to settings.json, a git commit message, or the
        // output panel armed a 400 ms timer whose only job was to call
        // validateDocument and have it bail on the languageId check.
        if (document.languageId !== 'asp') { return; }

        const key = document.uri.toString();
        const existing = debounceTimers.get(key);
        if (existing) { clearTimeout(existing); }
        debounceTimers.set(key, setTimeout(() => {
            debounceTimers.delete(key);
            validateDocument(document, collection);
        }, DEBOUNCE_MS));
    }

    // Validate all already-open .asp documents on activation (immediately)
    for (const document of vscode.workspace.textDocuments) {
        validateDocument(document, collection);
    }

    // Validate as you type — debounced
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            scheduleValidation(e.document);
        })
    );

    // Validate when a new document is opened (immediately)
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            validateDocument(document, collection);
        })
    );

    // Clear diagnostics and any pending timer when a document is closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            const key = document.uri.toString();
            const existing = debounceTimers.get(key);
            if (existing) { clearTimeout(existing); debounceTimers.delete(key); }
            collection.delete(document.uri);
        })
    );

    // Cancel all pending timers on deactivate
    context.subscriptions.push({
        dispose: () => {
            for (const timer of debounceTimers.values()) { clearTimeout(timer); }
            debounceTimers.clear();
        },
    });
}