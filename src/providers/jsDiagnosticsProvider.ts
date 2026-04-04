/**
 * jsDiagnosticsProvider.ts  (providers/)
 *
 * CSS-style diagnostics (error/warning squiggles) for JavaScript inside
 * <script> blocks in .asp files, powered by the TypeScript Language Service.
 *
 * Fixes vs previous version:
 *   • Removed the "blank line" guard that silently swallowed real errors on
 *     whitespace-only lines (e.g. stray semicolons on indented-only lines).
 *     The d.start/d.length undefined check is sufficient.
 *   • Diagnostic positions are now validated to fall inside a known JS range
 *     (from buildVirtualJsContent) rather than checking the trimmed line text,
 *     which was both wrong and lossy.
 *
 * What gets flagged:
 *   • Syntax errors   — always (e.g. missing brackets, unexpected tokens)
 *   • Semantic errors — basic ones only:
 *       - Wrong number of arguments (TS2554)
 *       - etc.
 *   Strict type errors (implicit any, return type mismatches) are suppressed
 *   via compiler options so inline scripts don't get flooded with warnings.
 *
 * Debounced at 750 ms — faster than the HTML structure checker (1500 ms)
 * because JS errors tend to be typed incrementally and need quick feedback.
 */

import * as vscode from 'vscode';
import * as ts     from 'typescript';
import {
    buildVirtualJsContent,
    getJsLanguageService,
    tsSeverityToVs,
} from '../utils/jsUtils';

// Diagnostic codes we deliberately suppress in inline script blocks.
// These are too noisy for small embedded scripts that don't import modules.
const SUPPRESSED_CODES = new Set([
    2304,   // Cannot find name 'X'  — too many false positives for globals
    2339,   // Property 'X' does not exist on type 'Y' — common for dynamic DOM
    2345,   // Argument of type 'X' is not assignable to parameter of type 'Y'
    2322,   // Type 'X' is not assignable to type 'Y'
    7006,   // Parameter 'X' implicitly has an 'any' type
    7005,   // Variable 'X' implicitly has an 'any' type
    2531,   // Object is possibly 'null'
    2532,   // Object is possibly 'undefined'
]);

function getDiagnosticsForDocument(
    document: vscode.TextDocument
): vscode.Diagnostic[] {
    const content = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // Build virtual JS content for the whole document
    const { virtualContent, isInScript: _ } = buildVirtualJsContent(content, 0);

    // Collect the JS ranges so we can validate diagnostic positions
    // (re-derive them the same way buildVirtualJsContent does)
    const jsRanges: Array<{ start: number; end: number }> = [];
    const scriptOpenRe = /<script(\s[^>]*)?>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = scriptOpenRe.exec(content)) !== null) {
        const attrs  = sm[1] ?? '';
        const tagEnd = sm.index + sm[0].length;
        const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
        if (typeMatch && !/javascript|module/i.test(typeMatch[1])) { continue; }
        if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs)) { continue; }
        const rest     = content.slice(tagEnd);
        const closeIdx = rest.search(/<\/script\s*>/i);
        const end      = closeIdx === -1 ? content.length : tagEnd + closeIdx;
        jsRanges.push({ start: tagEnd, end });
        scriptOpenRe.lastIndex = end;
    }

    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);

    const allDiags: ts.Diagnostic[] = [
        ...svc.getSyntacticDiagnostics(),
        ...svc.getSemanticDiagnostics(),
    ];

    for (const d of allDiags) {
        // Skip diagnostics with no position
        if (d.start === undefined || d.length === undefined) { continue; }

        // Suppress noisy codes that don't make sense for inline scripts
        const code = typeof d.code === 'number' ? d.code : 0;
        if (SUPPRESSED_CODES.has(code)) { continue; }

        // Only report errors whose start offset falls inside a real JS range.
        // This correctly filters out any phantom diagnostics TS might produce
        // for the blanked-out non-JS regions, without relying on line content.
        const inJs = jsRanges.some(r => d.start! >= r.start && d.start! < r.end);
        if (!inJs) { continue; }

        const startPos = document.positionAt(d.start);
        const endPos   = document.positionAt(d.start + d.length);

        const message = typeof d.messageText === 'string'
            ? d.messageText
            : ts.flattenDiagnosticMessageText(d.messageText, '\n');

        const diag = new vscode.Diagnostic(
            new vscode.Range(startPos, endPos),
            message,
            tsSeverityToVs(d.category)
        );
        diag.source = 'Classic ASP (JS)';
        diag.code   = code;
        diagnostics.push(diag);
    }

    return diagnostics;
}

export function registerJsDiagnostics(
    context: vscode.ExtensionContext
): void {
    const collection = vscode.languages.createDiagnosticCollection('classic-asp-js');
    context.subscriptions.push(collection);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    function schedule(document: vscode.TextDocument): void {
        if (document.languageId !== 'asp') { return; }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            collection.set(document.uri, getDiagnosticsForDocument(document));
        }, 750);
    }

    // Run on already-open documents
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'asp') {
            collection.set(doc.uri, getDiagnosticsForDocument(doc));
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(schedule),
        vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
    );
}