/**
 * jsAnalysisWorker.ts  (workers/)
 *
 * A worker thread that runs the JavaScript analysis that is recomputed after
 * every edit whether or not the user asked for anything: semantic
 * classification (type-aware colouring), semantic/syntactic diagnostics (the
 * error squiggles), and the Outline, read off the syntax tree the first two
 * have already parsed.
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

import * as ts from 'typescript';
import { getJsLanguageService, VIRTUAL_FILENAME } from '../js/jsUtils';
import { jsOutline, type JsOutlineSymbol } from '../js/jsOutline';
import { getJsBlockRanges, inRanges } from '../core/zoneUtils';
import { serveWorker, type WorkerAnswer } from './serveWorker';

export interface JsAnalysisRequest {
    id:   number;
    text: string;
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

function analyse(request: JsAnalysisRequest): JsAnalysisResult {
    const empty: JsAnalysisResult = {
        id: request.id, jsRanges: [], spans: [], diagnostics: [], outline: [],
    };

    const jsRanges = getJsBlockRanges(request.text);
    if (jsRanges.length === 0) { return empty; }

    const svc = getJsLanguageService();
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

// Analysis is best-effort: a half-typed document that trips the parser must
// cost this one refresh, not the worker.
serveWorker<JsAnalysisRequest, JsAnalysisResult>(analyse, request => ({
    id: request.id, jsRanges: [], spans: [], diagnostics: [], outline: [],
}));
