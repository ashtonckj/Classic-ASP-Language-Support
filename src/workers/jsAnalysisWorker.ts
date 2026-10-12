/**
 * jsAnalysisWorker.ts  (workers/)
 *
 * The one TypeScript service of the extension, on a worker thread, as VS
 * Code's own HTML support keeps its JavaScript service in its language server.
 * It answers two kinds of request about a page:
 *
 *   • its analysis, recomputed after every edit whether or not the user asked
 *     for anything: semantic classification (type-aware colouring),
 *     semantic/syntactic diagnostics (the error squiggles), and the Outline,
 *     read off the syntax tree the first two have already parsed;
 *   • a query — completion, hover, signature help, definition, references,
 *     highlights, rename, quick fixes — which is one JsLanguageService call,
 *     named in the request, its answer posted back as TypeScript gives it.
 *
 * The analysis is whole-file and takes over a second on a 670 KB <script>;
 * a query looks at one offset and takes tens of milliseconds. So a query never
 * waits behind an analysis: the extension host sends it first, and stops the
 * analysis under way through workerData.cancel, which the service's
 * cancellation token reads (analysisClient re-sends the analysis after).
 *
 * Nothing here may import vscode — a worker thread has no access to it. That
 * is why jsUtils.ts holds no vscode import and the two enum mappings that did
 * live in jsTsKinds.ts instead.
 */

import * as ts from 'typescript';
import { getJsLanguageService, VIRTUAL_FILENAME } from '../js/jsUtils';
import { jsOutline, type JsOutlineSymbol } from '../js/jsOutline';
import { getJsBlockRanges, inRanges } from '../core/zoneUtils';
import { workerData } from 'node:worker_threads';
import { serveWorker, type WorkerAnswer } from './serveWorker';

// Set to 1 by the extension host to stop the call under way (analysisClient).
// Absent when this file is loaded outside a worker, as the tests do.
const cancelFlag: Int32Array | undefined = workerData?.cancel;
const cancellation: ts.HostCancellationToken = {
    isCancellationRequested: () => cancelFlag !== undefined && Atomics.load(cancelFlag, 0) === 1,
};

/** The service calls a provider may ask for. */
export type JsQueryMethod =
    | 'getCompletions' | 'getCompletionDetails' | 'getQuickInfo' | 'getSignatureHelp'
    | 'getDefinitions' | 'getReferences' | 'getDocumentHighlights'
    | 'getRenameInfo' | 'findRenameLocations' | 'getCodeFixes';

export interface JsWorkerRequest {
    id:   number;
    /** The page, as it is now. */
    text: string;
    /** A question about the page; without one, the request is for its analysis. */
    query?: { method: JsQueryMethod; args: unknown[] };
}

/** What the service call in a query returned. */
export interface JsQueryAnswer extends WorkerAnswer {
    value?: unknown;
}

/** A ts.Diagnostic flattened to what survives being posted between threads. */
export interface PlainJsDiagnostic {
    /** A page offset. */
    start:    number;
    length:   number;
    code:     number;
    category: ts.DiagnosticCategory;
    message:  string;
}

export interface JsAnalysisResult extends WorkerAnswer {
    /** Empty when the document has no JavaScript at all. */
    jsRanges: Array<{ start: number; end: number }>;
    /** Classification triples: [offset, length, encoded] × n, inside the script only. */
    spans: number[];
    /** Inside the script only. */
    diagnostics: PlainJsDiagnostic[];
    /** The Outline's entries, in page offsets. */
    outline: JsOutlineSymbol[];
    /** Why the Outline is empty, when working it out threw; the rest still stands. */
    outlineError?: string;
}

function analyse(request: JsWorkerRequest): JsAnalysisResult {
    const jsRanges = getJsBlockRanges(request.text);
    if (jsRanges.length === 0) { return { id: request.id, jsRanges, spans: [], diagnostics: [], outline: [] }; }

    const svc = getJsLanguageService(cancellation);
    svc.loadPage(request.text, jsRanges);
    // `end` is the `<` of `</script>`, a valid place for a token that abuts the
    // closing tag, so the test is inclusive at both ends.
    const inScript = (offset: number) => inRanges(jsRanges, offset, false);

    // Classification first: it builds the program and the type checker that the
    // diagnostics then reuse, so this order pays for the type-check once.
    const classified = svc.getEncodedSemanticClassifications(0, request.text.length);
    const spans: number[] = [];
    for (let i = 0; i + 2 < classified.spans.length; i += 3) {
        if (inScript(classified.spans[i])) { spans.push(classified.spans[i], classified.spans[i + 1], classified.spans[i + 2]); }
    }

    const diagnostics: PlainJsDiagnostic[] = [];
    for (const d of [...svc.getSyntacticDiagnostics(), ...svc.getSemanticDiagnostics()]) {
        if (d.start === undefined || d.length === undefined || !inScript(d.start)) { continue; }
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

    // The tree the service has just parsed; a half-typed script that trips the
    // walk costs the Outline this once, not the colours and squiggles.
    let outline: JsOutlineSymbol[] = [];
    let outlineError: string | undefined;
    try {
        const sourceFile = svc.getProgram()?.getSourceFile(VIRTUAL_FILENAME);
        if (sourceFile) { outline = jsOutline(ts, sourceFile, jsRanges); }
    } catch (err) {
        outlineError = err instanceof Error ? err.stack ?? err.message : String(err);
    }

    return {
        id: request.id,
        jsRanges,
        spans,
        diagnostics,
        outline,
        outlineError,
    };
}

function answerQuery(request: JsWorkerRequest, query: NonNullable<JsWorkerRequest['query']>): JsQueryAnswer {
    const svc = getJsLanguageService(cancellation);
    svc.loadPage(request.text);
    const call = svc[query.method] as (...args: unknown[]) => unknown;
    return { id: request.id, value: call.apply(svc, query.args) };
}

/** The answer, or one marked `cancelled` when the host stopped the work. */
function answer(request: JsWorkerRequest): JsAnalysisResult | JsQueryAnswer {
    try {
        return request.query ? answerQuery(request, request.query) : analyse(request);
    } catch (error) {
        if (!(error instanceof ts.OperationCanceledException)) { throw error; }
        return { ...emptyAnswer(request), cancelled: true };
    }
}

function emptyAnswer(request: JsWorkerRequest): JsAnalysisResult | JsQueryAnswer {
    return request.query ? { id: request.id } : { id: request.id, jsRanges: [], spans: [], diagnostics: [], outline: [] };
}

// Best-effort: a half-typed document that trips the parser must cost this one
// answer, not the worker.
serveWorker<JsWorkerRequest, JsAnalysisResult | JsQueryAnswer>(answer, emptyAnswer);
