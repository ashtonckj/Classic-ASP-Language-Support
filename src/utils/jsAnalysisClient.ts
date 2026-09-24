/**
 * jsAnalysisClient.ts  (utils/)
 *
 * The extension-host side of jsAnalysisWorker.ts. Owns one long-lived worker
 * and hands out promises for whole-file JavaScript analysis.
 *
 * Three rules shape it:
 *
 *   • One job at a time, newest wins — per document. The worker is synchronous
 *     inside, so queueing every keystroke would only build a backlog whose
 *     results are thrown away on arrival. A request replaces whatever was
 *     waiting for the SAME document, and the displaced caller is answered with
 *     undefined. It never displaces another document's request: with one slot
 *     for the whole window, two visible pages (or a session restored with
 *     several open) knocked each other out, and the loser lost its colouring
 *     and had its squiggles cleared until it was next edited.
 *
 *   • The same text is analysed once. Colouring and squiggles both ask about
 *     the document after an edit; a second request for text already waiting
 *     or being analysed shares that answer instead of displacing it, and one
 *     for text that was answered last is given that answer again.
 *
 *   • Never reject. Both callers are decoration paths — colouring and
 *     squiggles. A worker that dies must cost a refresh, not surface an
 *     extension error to the user, so every failure resolves to undefined and
 *     the next call starts a fresh worker.
 */

import * as path from 'path';
import { Worker } from 'node:worker_threads';
import type { JsAnalysisResult } from './jsAnalysisWorker';

export type { JsAnalysisResult, PlainJsDiagnostic } from './jsAnalysisWorker';

const WORKER_PATH = path.join(__dirname, 'jsAnalysisWorker.js');

// A worker that cannot start is usually a packaging problem, which retrying
// will not solve. Stop respawning after this many consecutive failures and
// leave the feature off rather than spawning a thread per keystroke forever.
const MAX_CONSECUTIVE_FAILURES = 3;

type Resolver = (result: JsAnalysisResult | undefined) => void;

let _worker: Worker | undefined;
let _nextId = 1;
let _failures = 0;
interface Job { text: string; resolvers: Resolver[]; }

let _inFlight: (Job & { id: number; key: string }) | undefined;
// Waiting jobs, at most one per document, in the order they were asked for.
const _queued = new Map<string, Job>();

// The last answer for each document. The squiggles ask 750 ms after an edit,
// and on a page the worker gets through faster than that, the colouring has
// already been answered for the same text by then, so without this the page
// was type-checked twice per edit. Only the most recent documents are kept.
const MAX_REMEMBERED = 8;
const _lastAnswer = new Map<string, { text: string; result: JsAnalysisResult }>();

function remember(key: string, text: string, result: JsAnalysisResult): void {
    // An empty answer is also what a failed analysis looks like, so it is not
    // kept: asking again is the only way to recover from that.
    if (result.jsRanges.length === 0) { return; }
    _lastAnswer.delete(key);
    _lastAnswer.set(key, { text, result });
    if (_lastAnswer.size > MAX_REMEMBERED) { _lastAnswer.delete(_lastAnswer.keys().next().value!); }
}

function answer(job: Job | undefined, result: JsAnalysisResult | undefined): void {
    for (const resolve of job?.resolvers ?? []) { resolve(result); }
}

function failAllPending(): void {
    answer(_inFlight, undefined);
    _inFlight = undefined;
    for (const job of _queued.values()) { answer(job, undefined); }
    _queued.clear();
}

function teardown(): void {
    const worker = _worker;
    _worker = undefined;
    failAllPending();
    void worker?.terminate();
}

function ensureWorker(): Worker | undefined {
    if (_worker) { return _worker; }
    if (_failures >= MAX_CONSECUTIVE_FAILURES) { return undefined; }

    try {
        const worker = new Worker(WORKER_PATH);

        worker.on('message', (result: JsAnalysisResult) => {
            _failures = 0;
            const pending = _inFlight;
            _inFlight = undefined;

            // A reply for anything but the current request is a leftover from a
            // worker that was replaced; ignore it.
            const current = pending !== undefined && pending.id === result.id;
            if (current) { remember(pending.key, pending.text, result); }
            answer(pending, current ? result : undefined);

            send();
        });

        // 'exit' fires after 'error' too, so both funnel into the same teardown
        // and the next caller gets a fresh worker.
        worker.on('error', () => { _failures++; teardown(); });
        worker.on('exit',  () => { if (_worker === worker) { teardown(); } });

        _worker = worker;
        return worker;
    } catch {
        _failures++;
        return undefined;
    }
}

/** Posts the oldest waiting job, if the worker is free and there is one. */
function send(): void {
    if (_inFlight || _queued.size === 0) { return; }

    const worker = ensureWorker();
    if (!worker) { failAllPending(); return; }

    const [key, job] = _queued.entries().next().value!;
    _queued.delete(key);

    const id = _nextId++;
    _inFlight = { ...job, id, key };
    try {
        worker.postMessage({ id, text: job.text });
    } catch {
        _inFlight = undefined;
        answer(job, undefined);
        teardown();
    }
}

/**
 * Classification spans and diagnostics for the JavaScript embedded in `text`,
 * the current text of the document `key` (its URI), or undefined when a newer
 * request for that document superseded this one or the worker could not answer.
 * Offsets in the result are in virtual-file space; subtract `preambleLength`
 * to get document offsets.
 */
export function analyseEmbeddedJs(key: string, text: string): Promise<JsAnalysisResult | undefined> {
    return new Promise<JsAnalysisResult | undefined>(resolve => {
        const last = _lastAnswer.get(key);
        if (last?.text === text) {
            resolve(last.result);
            return;
        }

        if (_inFlight?.key === key && _inFlight.text === text) {
            _inFlight.resolvers.push(resolve);
            return;
        }

        const waiting = _queued.get(key);
        if (waiting?.text === text) {
            waiting.resolvers.push(resolve);
            return;
        }

        // Newest wins for this document: what was waiting is already out of
        // date. It moves to the back, behind any other document's request.
        answer(waiting, undefined);
        _queued.delete(key);
        _queued.set(key, { text, resolvers: [resolve] });
        send();
    });
}

/** Shuts the worker down. Called from deactivate. */
export function disposeJsAnalysisWorker(): void {
    _failures = 0;
    _lastAnswer.clear();
    teardown();
}
