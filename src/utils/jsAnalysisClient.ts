/**
 * jsAnalysisClient.ts  (utils/)
 *
 * The extension-host side of jsAnalysisWorker.ts. Owns one long-lived worker
 * and hands out promises for whole-file JavaScript analysis.
 *
 * Two rules shape it:
 *
 *   • One job at a time, newest wins. The worker is synchronous inside, so a
 *     queue would only let a backlog build up while the user keeps typing, and
 *     every result but the last would be thrown away on arrival anyway. A
 *     request that arrives while the worker is busy replaces whatever was
 *     waiting, and the displaced caller is answered with undefined.
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
let _inFlight: { id: number; resolve: Resolver } | undefined;
let _queued: { text: string; resolve: Resolver } | undefined;

function failAllPending(): void {
    _inFlight?.resolve(undefined);
    _inFlight = undefined;
    _queued?.resolve(undefined);
    _queued = undefined;
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
            if (pending && pending.id === result.id) { pending.resolve(result); }
            else { pending?.resolve(undefined); }

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

/** Posts the queued request, if the worker is free and there is one waiting. */
function send(): void {
    if (_inFlight || !_queued) { return; }

    const worker = ensureWorker();
    if (!worker) { failAllPending(); return; }

    const { text, resolve } = _queued;
    _queued = undefined;

    const id = _nextId++;
    _inFlight = { id, resolve };
    try {
        worker.postMessage({ id, text });
    } catch {
        _inFlight = undefined;
        resolve(undefined);
        teardown();
    }
}

/**
 * Classification spans and diagnostics for the JavaScript embedded in `text`,
 * or undefined when the request was superseded by a newer one or the worker
 * could not answer. Offsets in the result are in virtual-file space; subtract
 * `preambleLength` to get document offsets.
 */
export function analyseEmbeddedJs(text: string): Promise<JsAnalysisResult | undefined> {
    return new Promise<JsAnalysisResult | undefined>(resolve => {
        // Newest wins: whatever was waiting is already out of date.
        _queued?.resolve(undefined);
        _queued = { text, resolve };
        send();
    });
}

/** Shuts the worker down. Called from deactivate. */
export function disposeJsAnalysisWorker(): void {
    _failures = 0;
    teardown();
}
