/**
 * jsAnalysisWorker.ts  (utils/)
 *
 * A worker thread that runs the two pieces of JavaScript analysis that are
 * recomputed after every edit whether or not the user asked for anything:
 * semantic classification (type-aware colouring) and semantic/syntactic
 * diagnostics (the error squiggles).
 *
 * Why these two and not the rest. TypeScript resolves types lazily, so a query
 * about ONE offset — a completion, a hover, a Go to Definition — only checks
 * what that offset depends on, and measured about a third of a whole-file pass.
 * These two are whole-file by definition and measured over a second each on a
 * 670 KB <script> block, on a thread that also has to run this extension's
 * auto-close, indent and suggestion handling. Moving the on-demand queries here
 * too would be worse, not better: this thread handles one job at a time, so a
 * completion would then have to wait behind a classification it has nothing to
 * do with. They stay on the extension host, where they are cheap and prompt.
 *
 * Nothing here may import vscode — a worker thread has no access to it. That
 * is why jsUtils.ts holds no vscode import and the two enum mappings that did
 * live in jsTsKinds.ts instead.
 */

import { parentPort } from 'node:worker_threads';
import * as ts from 'typescript';
import { buildVirtualJsContent, getJsLanguageService, getJsRanges } from './jsUtils';

export interface JsAnalysisRequest {
    id:   number;
    text: string;
}

/** A ts.Diagnostic flattened to what survives being posted between threads. */
export interface PlainJsDiagnostic {
    /** Offset in VIRTUAL-file space, as TypeScript reports it. */
    start:    number;
    length:   number;
    code:     number;
    category: ts.DiagnosticCategory;
    message:  string;
}

export interface JsAnalysisResult {
    id: number;
    /** Empty when the document has no JavaScript at all. */
    jsRanges: Array<{ start: number; end: number }>;
    preambleLength: number;
    /** Classification triples: [virtualOffset, length, encoded] × n. */
    spans: number[];
    diagnostics: PlainJsDiagnostic[];
}

function analyse(request: JsAnalysisRequest): JsAnalysisResult {
    const empty: JsAnalysisResult = {
        id: request.id, jsRanges: [], preambleLength: 0, spans: [], diagnostics: [],
    };

    const jsRanges = getJsRanges(request.text);
    if (jsRanges.length === 0) { return empty; }

    const { virtualContent, preambleLength } = buildVirtualJsContent(request.text, 0);

    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);

    // Classification first: it builds the program and the type checker that the
    // diagnostics then reuse, so this order pays for the type-check once.
    const classified = svc.getEncodedSemanticClassifications(0, virtualContent.length);

    const diagnostics: PlainJsDiagnostic[] = [];
    for (const d of [...svc.getSyntacticDiagnostics(), ...svc.getSemanticDiagnostics()]) {
        if (d.start === undefined || d.length === undefined) { continue; }
        diagnostics.push({
            start:    d.start,
            length:   d.length,
            code:     typeof d.code === 'number' ? d.code : 0,
            category: d.category,
            // ts.Diagnostic carries a `file` pointing at the whole SourceFile
            // AST. Posting that between threads would mean cloning the entire
            // tree, so the message is flattened to a string here and the node
            // reference is left behind.
            message:  typeof d.messageText === 'string'
                ? d.messageText
                : ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        });
    }

    return {
        id: request.id,
        jsRanges,
        preambleLength,
        spans: Array.from(classified.spans),
        diagnostics,
    };
}

parentPort?.on('message', (request: JsAnalysisRequest) => {
    try {
        parentPort?.postMessage(analyse(request));
    } catch {
        // Analysis is best-effort: a half-typed document that trips the parser
        // must cost this one refresh, not the worker.
        parentPort?.postMessage({
            id: request.id, jsRanges: [], preambleLength: 0, spans: [], diagnostics: [],
        } satisfies JsAnalysisResult);
    }
});
