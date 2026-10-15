/**
 * jsDiagnosticsProvider.ts  (js/)
 *
 * Error/warning squiggles for JavaScript inside <script> blocks and on…=""
 * values, powered by the TypeScript Language Service. Debounced at 750 ms.
 *
 * The analysis itself runs on a worker thread (jsAnalysisWorker.ts) and what
 * comes back is plain data, because a ts.Diagnostic holds a reference to the
 * whole SourceFile AST and could not cross a thread boundary intact. This file
 * turns that data into vscode.Diagnostics and nothing more.
 *
 * Suppressed diagnostic codes are listed in SUPPRESSED_CODES — these are too
 * noisy for small inline scripts that don't import modules. Only structural
 * errors like wrong argument counts and genuine syntax errors are surfaced.
 */

import * as vscode from 'vscode';
import { CHECK_DELAY, createAspDiagnosticCollection, makeDiagnostic, watchAspDocuments } from '../platform/diagnostics';
import { analyseEmbeddedJs } from '../workers/analysisClient';
import { includeNamedElements } from '../asp/includeProvider';
import { tsSeverityToVs } from './jsTsKinds';
import { textOf, zonesFor } from '../platform/documentState';

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
    const fullText = textOf(document);

    // Worth checking before waking the worker: most pages have no JavaScript.
    const zones = zonesFor(document);
    if (zones.jsBlocks.length === 0 && zones.markup.eventHandlers.length === 0) { return []; }

    // Type-checking the whole script block is the most expensive thing this
    // extension does, so it happens on a worker thread rather than on the
    // extension host — see jsAnalysisWorker.ts.
    const analysis = await analyseEmbeddedJs(document.uri.toString(), fullText, undefined, includeNamedElements(document));
    if (!analysis) { return []; }

    return analysis.diagnostics
        .filter(d => !SUPPRESSED_CODES.has(d.code))
        .map(d => makeDiagnostic(
            new vscode.Range(document.positionAt(d.start), document.positionAt(d.start + d.length)),
            d.message,
            tsSeverityToVs(d.category),
            d.code,
        ));
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