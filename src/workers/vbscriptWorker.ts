/**
 * vbscriptWorker.ts  (workers/)
 *
 * A worker thread that reads VBScript pages after every edit, so a large page
 * never holds up the extension host — the thread that also handles every key
 * typed (auto-close, indent) and every other extension's requests.
 *
 * It answers the whole-page work that runs whether or not the user asked for
 * anything: the page's own symbols (completion, the outline) and its blocks
 * (the structure warnings, the matching-keyword highlight, the object of each
 * With block), and — a moment after typing stops — its checks, which bind the
 * page with its includes. Each version of a file is parsed once here, however
 * many of those ask about it. It also reads the include tree completion
 * offers names from, with the same parses the checks use.
 *
 * What runs only when the user asks — hover, Go to Definition, rename, Find
 * All References, parameter hints — stays on the extension host, as the
 * JavaScript features do (see jsAnalysisWorker.ts): this thread does one job
 * at a time, and a hover would otherwise wait behind a whole-page pass.
 *
 * Nothing here may import vscode — a worker thread has no access to it.
 */

import type { ParsedPage } from '../vbscript/symbols';
import { ParseCache } from '../vbscript/parseCache';
import { analysePage, type PageAnalysis } from '../vbscript/pageAnalysis';
import { checkPageFiles, includeFiles, type ChecksRequest as PageChecksRequest, type IncludeFile, type PageChecks, type ScopeRequest } from '../vbscript/pageChecks';
import { serveWorker, type WorkerAnswer } from './serveWorker';

export interface PageRequest {
    id:      number;
    kind:    'page';
    text:    string;
    docPath: string;
}

export type ChecksRequest = PageChecksRequest & { id: number; kind: 'checks' };
export type IncludesRequest = ScopeRequest & { id: number; kind: 'includes' };

export type PageResult   = PageAnalysis & WorkerAnswer;
export type ChecksResult = PageChecks & WorkerAnswer;
export type IncludesResult = { entries: IncludeFile[] } & WorkerAnswer;

/** The last parse of each recent file, so a second question about the same text parses nothing. */
const parsed = new ParseCache(200, 8_000_000);
const parseCached = (fsPath: string, text: string): ParsedPage => parsed.parse(fsPath, text);

type Request = PageRequest | ChecksRequest | IncludesRequest;
type Result  = PageResult | ChecksResult | IncludesResult;

function answer(request: Request): Result {
    switch (request.kind) {
        case 'page':     return { id: request.id, ...analysePage(parseCached(request.docPath, request.text), request.docPath) };
        case 'checks':   return { id: request.id, ...checkPageFiles(request, parseCached) };
        case 'includes': return { id: request.id, entries: includeFiles(request, parseCached) };
    }
}

// A half-typed page that trips a pass must cost this one answer, not the worker.
serveWorker<Request, Result>(answer, request => {
    switch (request.kind) {
        case 'page': return {
            id: request.id,
            symbols: { variables: [], constants: [], functions: [], comVariables: [], classes: [] },
            blocks: { warnings: [], pairs: [], withBlocks: [], events: [] },
        };
        case 'checks':   return { id: request.id, missingSet: [], checks: [] };
        case 'includes': return { id: request.id, entries: [] };
    }
});
