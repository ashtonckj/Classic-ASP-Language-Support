/**
 * vbscriptWorker.ts  (utils/)
 *
 * A worker thread that reads VBScript pages after every edit, so a large page
 * never holds up the extension host — the thread that also handles every key
 * typed (auto-close, indent) and every other extension's requests.
 *
 * It answers the whole-page work that runs whether or not the user asked for
 * anything: the page's own symbols (completion, the outline) and its blocks
 * (the structure warnings, the matching-keyword highlight, the object of each
 * With block). Each version of a page is parsed once here, however many of
 * those ask about it.
 *
 * What runs only when the user asks — hover, Go to Definition, rename, Find
 * All References, parameter hints — stays on the extension host, as the
 * JavaScript features do (see jsAnalysisWorker.ts): this thread does one job
 * at a time, and a hover would otherwise wait behind a whole-page pass.
 *
 * Nothing here may import vscode — a worker thread has no access to it.
 */

import { parentPort } from 'node:worker_threads';
import { parsePage, type ParsedPage } from '../vbscript/symbols';
import { analysePage, type PageAnalysis } from '../vbscript/pageAnalysis';

export interface PageRequest {
    id:      number;
    kind:    'page';
    text:    string;
    docPath: string;
}

export type PageResult = PageAnalysis & { id: number; failed?: boolean };

/** The last parse of each recent file, so a second question about the same text parses nothing. */
const parsed = new Map<string, ParsedPage>();
const PARSED_LIMIT = 50;

function parseCached(fsPath: string, text: string): ParsedPage {
    const key = fsPath.toLowerCase();
    const known = parsed.get(key);
    if (known && known.text === text) { return known; }
    const page = parsePage(text);
    parsed.delete(key);
    parsed.set(key, page);
    if (parsed.size > PARSED_LIMIT) { parsed.delete(parsed.keys().next().value!); }
    return page;
}

function answer(request: PageRequest): PageResult {
    return { id: request.id, ...analysePage(parseCached(request.docPath, request.text), request.docPath) };
}

parentPort?.on('message', (request: PageRequest) => {
    let result: PageResult;
    try {
        result = answer(request);
    } catch {
        // A half-typed page that trips a pass must cost this one answer, not the worker.
        result = {
            id: request.id, failed: true,
            symbols: { variables: [], constants: [], functions: [], comVariables: [], classes: [] },
            blocks: { warnings: [], pairs: [], withBlocks: [] },
        };
    }
    parentPort?.postMessage(result);
});
