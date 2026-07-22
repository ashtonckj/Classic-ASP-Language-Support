/**
 * jsDiagnosticsProvider.ts  (providers/)
 *
 * Error/warning squiggles for JavaScript inside <script> blocks, powered by
 * the TypeScript Language Service. Debounced at 750 ms.
 *
 * Suppressed diagnostic codes are listed in SUPPRESSED_CODES — these are too
 * noisy for small inline scripts that don't import modules. Only structural
 * errors like wrong argument counts and genuine syntax errors are surfaced.
 *
 * preambleLength is subtracted from every diagnostic start position before
 * converting to a VS Code Range, since the virtual file has the preamble
 * prepended and all TS positions are relative to that.
 */

import * as vscode from 'vscode';
import * as ts from 'typescript';
import {
    buildVirtualJsContent,
    getJsLanguageService,
    getJsRanges,
    tsSeverityToVs,
} from '../utils/jsUtils';

const SUPPRESSED_CODES = new Set([
    2304,   // Cannot find name 'X'
    2592,   // Cannot find name '$' / 'jQuery' (TS hint variant of 2304 for known library globals)
    2339,   // Property 'X' does not exist on type 'Y'
    2345,   // Argument of type 'X' is not assignable to parameter of type 'Y'
    2322,   // Type 'X' is not assignable to type 'Y'
    7006,   // Parameter 'X' implicitly has an 'any' type
    7005,   // Variable 'X' implicitly has an 'any' type
    2531,   // Object is possibly 'null'
    2532,   // Object is possibly 'undefined'
    2349,   // This expression is not callable (e.g. window[name]() dynamic dispatch)
    2367,   // Comparison does not have overlap
]);

function getDiagnosticsForDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const fullText = document.getText();
    const jsRanges = getJsRanges(fullText);
    if (jsRanges.length === 0) { return []; }

    const { virtualContent, preambleLength } = buildVirtualJsContent(fullText, 0);
    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);

    const allDiags: ts.Diagnostic[] = [
        ...svc.getSyntacticDiagnostics(),
        ...svc.getSemanticDiagnostics(),
    ];

    const diagnostics: vscode.Diagnostic[] = [];

    for (const d of allDiags) {
        if (d.start === undefined || d.length === undefined) { continue; }

        const code = typeof d.code === 'number' ? d.code : 0;
        if (SUPPRESSED_CODES.has(code)) { continue; }

        // Convert virtual-file position back to document space by subtracting
        // the preamble length. Skip anything that lands inside the preamble itself.
        const docStart = d.start - preambleLength;

        // Guard against diagnostics that fall inside the preamble itself.
        if (docStart < 0) { continue; }

        // `end` in getJsRanges is the offset of `<` in `</script>`, which is a
        // valid position for a token that abuts the closing tag (use <=).
        if (!jsRanges.some(r => docStart >= r.start && docStart <= r.end)) { continue; }

        const message = typeof d.messageText === 'string'
            ? d.messageText
            : ts.flattenDiagnosticMessageText(d.messageText, '\n');

        const diag = new vscode.Diagnostic(
            new vscode.Range(
                document.positionAt(docStart),
                document.positionAt(docStart + d.length)
            ),
            message,
            tsSeverityToVs(d.category)
        );
        diag.source = 'Classic ASP (JS)';
        diag.code   = code;
        diagnostics.push(diag);
    }

    return diagnostics;
}

export function registerJsDiagnostics(context: vscode.ExtensionContext): void {
    const collection = vscode.languages.createDiagnosticCollection('classic-asp-js');
    context.subscriptions.push(collection);

    // Per-document debounce timers, keyed by URI, so editing one open .asp file
    // never cancels another file's pending scan (a single shared timer did).
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function schedule(document: vscode.TextDocument): void {
        if (document.languageId !== 'asp') { return; }
        const key = document.uri.toString();
        const existing = debounceTimers.get(key);
        if (existing) { clearTimeout(existing); }
        debounceTimers.set(key, setTimeout(() => {
            debounceTimers.delete(key);
            collection.set(document.uri, getDiagnosticsForDocument(document));
        }, 750));
    }

    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'asp') {
            collection.set(doc.uri, getDiagnosticsForDocument(doc));
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(schedule),
        vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            const existing = debounceTimers.get(key);
            if (existing) { clearTimeout(existing); debounceTimers.delete(key); }
            collection.delete(doc.uri);
        }),
    );

    // Cancel any pending timers on deactivate.
    context.subscriptions.push({
        dispose: () => {
            for (const timer of debounceTimers.values()) { clearTimeout(timer); }
            debounceTimers.clear();
        },
    });
}