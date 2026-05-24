/**
 * jsDiagnosticsProvider.ts  (providers/)
 *
 * Error/warning squiggles for JavaScript inside <script> blocks, powered by
 * the TypeScript Language Service. Debounced at 750 ms.
 *
 * Suppressed diagnostic codes are listed in SUPPRESSED_CODES — these are too
 * noisy for small inline scripts that don't import modules (missing names,
 * type mismatches, implicit any, etc.). Only structural errors like wrong
 * argument counts and genuine syntax errors are surfaced.
 */

import * as vscode from 'vscode';
import * as ts     from 'typescript';
import {
    buildVirtualJsContent,
    getJsLanguageService,
    getJsRanges,        // ← now shared from jsUtils (fix #2)
    tsSeverityToVs,
} from '../utils/jsUtils';

const SUPPRESSED_CODES = new Set([
    2304,   // Cannot find name 'X'
    2339,   // Property 'X' does not exist on type 'Y'
    2345,   // Argument of type 'X' is not assignable to parameter of type 'Y'
    2322,   // Type 'X' is not assignable to type 'Y'
    7006,   // Parameter 'X' implicitly has an 'any' type
    7005,   // Variable 'X' implicitly has an 'any' type
    2531,   // Object is possibly 'null'
    2532,   // Object is possibly 'undefined'
]);

function getDiagnosticsForDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const fullText = document.getText();
    const jsRanges = getJsRanges(fullText);
    if (jsRanges.length === 0) { return []; }

    const { virtualContent } = buildVirtualJsContent(fullText, 0);
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

        // FIX #4: use `d.start! <= r.end` (was `< r.end`) so that a diagnostic
        // whose start sits exactly on the last character of a JS range is still
        // accepted. `end` in getJsRanges is the offset of `<` in `</script>`,
        // which is a valid position for a token that abuts the closing tag.
        if (!jsRanges.some(r => d.start! >= r.start && d.start! <= r.end)) { continue; }

        const message = typeof d.messageText === 'string'
            ? d.messageText
            : ts.flattenDiagnosticMessageText(d.messageText, '\n');

        const diag = new vscode.Diagnostic(
            new vscode.Range(document.positionAt(d.start), document.positionAt(d.start + d.length)),
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

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    function schedule(document: vscode.TextDocument): void {
        if (document.languageId !== 'asp') { return; }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            collection.set(document.uri, getDiagnosticsForDocument(document));
        }, 750);
    }

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