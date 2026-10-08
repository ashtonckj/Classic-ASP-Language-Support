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
 * many of those ask about it.
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
import { checkPageFiles, type ChecksRequest as PageChecksRequest, type PageChecks } from '../vbscript/pageChecks';
import { serveWorker, type WorkerAnswer } from './serveWorker';

export interface PageRequest {
    id:      number;
    kind:    'page';
    text:    string;
    docPath: string;
}

export type ChecksRequest = PageChecksRequest & { id: number; kind: 'checks' };

export type PageResult   = PageAnalysis & WorkerAnswer;
export type ChecksResult = PageChecks & WorkerAnswer;

/** The last parse of each recent file, so a second question about the same text parses nothing. */
const parsed = new ParseCache(50, 4_000_000);
const parseCached = (fsPath: string, text: string): ParsedPage => parsed.parse(fsPath, text);

function answer(request: PageRequest | ChecksRequest): PageResult | ChecksResult {
    return request.kind === 'page'
        ? { id: request.id, ...analysePage(parseCached(request.docPath, request.text), request.docPath) }
        : { id: request.id, ...checkPageFiles(request, parseCached) };
}

// A half-typed page that trips a pass must cost this one answer, not the worker.
serveWorker<PageRequest | ChecksRequest, PageResult | ChecksResult>(answer, request => request.kind === 'page'
    ? {
        id: request.id,
        symbols: { variables: [], constants: [], functions: [], comVariables: [], classes: [] },
        blocks: { warnings: [], pairs: [], withBlocks: [], events: [] },
    }
    : { id: request.id, missingSet: [], checks: [] });
