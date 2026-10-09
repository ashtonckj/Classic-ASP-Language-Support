/**
 * jsDiagnosticsProvider.ts  (js/)
 *
 * Error/warning squiggles for JavaScript inside <script> blocks, powered by
 * the TypeScript Language Service. Debounced at 750 ms.
 *
 * The analysis itself runs on a worker thread (jsAnalysisWorker.ts) and what
 * comes back is plain data, because a ts.Diagnostic holds a reference to the
 * whole SourceFile AST and could not cross a thread boundary intact. This file
 * turns that data into vscode.Diagnostics and nothing more.
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
import { CHECK_DELAY, createAspDiagnosticCollection, makeDiagnostic, watchAspDocuments } from '../platform/diagnostics';
import { analyseEmbeddedJs } from '../workers/analysisClient';
import { tsSeverityToVs } from './jsTsKinds';
import { inRanges } from '../core/zoneUtils';

// Codes suppressed because embedded ASP <script> lacks whole-project context
// (cross-file globals, jQuery, DOM null-returns, implicit any). ASP-injected
// values are projected as `any`, so they never produce genuine type/logic errors
// on their own — which is why real-bug codes like 2339 (property does not exist)
// and 2367 (comparison has no overlap) are deliberately NOT suppressed: they only
// fire on real, fully-typed JS mistakes (e.g. calling a string method on a number).
export const SUPPRESSED_CODES = new Set([
    2304,   // Cannot find name 'X'          (functions/vars defined in other blocks/includes)
    2592,   // Cannot find name '$' / 'jQuery'
    2345,   // Argument of type 'X' is not assignable to parameter of type 'Y'
    2322,   // Type 'X' is not assignable to type 'Y'
    7006,   // Parameter 'X' implicitly has an 'any' type
    7005,   // Variable 'X' implicitly has an 'any' type
    2531,   // Object is possibly 'null'      (document.getElementById(...) returns | null)
    2532,   // Object is possibly 'undefined'
    2349,   // This expression is not callable (e.g. window[name]() dynamic dispatch)
]);

async function getDiagnosticsForDocument(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const fullText = document.getText();

    // Worth checking before waking the worker: most pages have no <script>.
    if (!/<script/i.test(fullText)) { return []; }

    // Type-checking the whole script block is the most expensive thing this
    // extension does, so it happens on a worker thread rather than on the
    // extension host — see jsAnalysisWorker.ts.
    const analysis = await analyseEmbeddedJs(document.uri.toString(), fullText);
    if (!analysis || analysis.jsRanges.length === 0) { return []; }

    const { jsRanges, preambleLength } = analysis;
    const diagnostics: vscode.Diagnostic[] = [];

    for (const d of analysis.diagnostics) {
        if (SUPPRESSED_CODES.has(d.code)) { continue; }

        // Convert virtual-file position back to document space by subtracting
        // the preamble length. Skip anything that lands inside the preamble itself.
        const docStart = d.start - preambleLength;

        // Guard against diagnostics that fall inside the preamble itself.
        if (docStart < 0) { continue; }

        // `end` in getJsBlockRanges is the offset of `<` in `</script>`, which is a
        // valid position for a token that abuts the closing tag, so the test is
        // inclusive at both ends.
        if (!inRanges(jsRanges, docStart, false)) { continue; }

        diagnostics.push(makeDiagnostic(
            new vscode.Range(document.positionAt(docStart), document.positionAt(docStart + d.length)),
            d.message,
            tsSeverityToVs(d.category),
            d.code,
        ));
    }

    return diagnostics;
}

export function registerJsDiagnostics(context: vscode.ExtensionContext): void {
    const collection = createAspDiagnosticCollection('classic-asp-js');
    context.subscriptions.push(collection);

    watchAspDocuments(context, {
        delay: CHECK_DELAY.js,
        check: document => {
            // The document may change again while the worker is busy; publishing
            // ranges measured against text that has moved on would put squiggles
            // in the wrong places. A newer edit arms its own timer.
            const requestedVersion = document.version;
            void getDiagnosticsForDocument(document).then(diagnostics => {
                if (!document.isClosed && document.version === requestedVersion) {
                    collection.set(document.uri, diagnostics);
                }
            });
        },
        collections: [collection],
    });
}