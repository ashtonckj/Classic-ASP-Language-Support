/**
 * analysisClient.ts  (utils/)
 *
 * The extension-host side of the two page-analysis workers:
 *
 *   • jsAnalysisWorker.ts — the type-aware JavaScript colouring and the JS
 *     squiggles, both from one TypeScript pass;
 *   • aspColouring.ts     — the VBScript and SQL colouring, and the SQL warnings.
 *
 * Each is a long-lived worker thread of its own, so neither waits behind the
 * other, and both are driven the same way:
 *
 *   • One job at a time, newest wins — per document. A worker is synchronous
 *     inside, so queueing every keystroke would only build a backlog whose
 *     results are thrown away on arrival. A request replaces whatever was
 *     waiting for the SAME document, and the displaced caller is answered with
 *     undefined. It never displaces another document's request: with one slot
 *     for the whole window, two visible pages (or a session restored with
 *     several open) knocked each other out, and the loser lost its colouring
 *     and had its squiggles cleared until it was next edited.
 *
 *   • The same input is worked out once. A second request for input already
 *     waiting or being worked on shares that answer instead of displacing it,
 *     and one for the input answered last is given that answer again.
 *
 *   • Never reject. Every caller is a decoration path — colours and squiggles.
 *     A worker that dies must cost a refresh, not surface an extension error to
 *     the user, so every failure resolves to undefined and the next call starts
 *     a fresh worker.
 */

import * as path from 'path';
import { Worker } from 'node:worker_threads';
import type { JsAnalysisResult } from './jsAnalysisWorker';
import type { AspColouringRequest, AspColouringResult } from './aspColouring';
import type { FileSymbols } from './symbolParser';

export type { JsAnalysisResult, PlainJsDiagnostic } from './jsAnalysisWorker';
export type { AspColouringResult, SqlWarning } from './aspColouring';

// A worker that cannot start is usually a packaging problem, which retrying
// will not solve. Stop respawning after this many consecutive failures and
// leave the feature off rather than spawning a thread per keystroke forever.
const MAX_CONSECUTIVE_FAILURES = 3;

// Answers kept for reuse, for the most recent documents only.
const MAX_REMEMBERED = 8;

type Resolver<R> = (result: R | undefined) => void;

interface Job<I, R> { input: I; resolvers: Resolver<R>[]; }

/** A long-lived worker thread and the requests waiting for it. */
class AnalysisWorker<I extends { text: string }, R extends { id: number }> {
    private worker: Worker | undefined;
    private nextId   = 1;
    private failures = 0;
    private inFlight: (Job<I, R> & { id: number; key: string }) | undefined;
    // Waiting jobs, at most one per document, in the order they were asked for.
    private readonly queued = new Map<string, Job<I, R>>();
    private readonly lastAnswer = new Map<string, { input: I; result: R }>();

    constructor(
        private readonly workerPath: string,
        /** True when two requests would get the same answer. */
        private readonly sameInput: (a: I, b: I) => boolean,
        /** False for an answer that may be a failure in disguise, which is not kept. */
        private readonly worthKeeping: (result: R) => boolean,
    ) {}

    request(key: string, input: I): Promise<R | undefined> {
        return new Promise<R | undefined>(resolve => {
            const last = this.lastAnswer.get(key);
            if (last && this.sameInput(last.input, input)) {
                resolve(last.result);
                return;
            }

            if (this.inFlight?.key === key && this.sameInput(this.inFlight.input, input)) {
                this.inFlight.resolvers.push(resolve);
                return;
            }

            const waiting = this.queued.get(key);
            if (waiting && this.sameInput(waiting.input, input)) {
                waiting.resolvers.push(resolve);
                return;
            }

            // Newest wins for this document: what was waiting is already out of
            // date. It moves to the back, behind any other document's request.
            this.answer(waiting, undefined);
            this.queued.delete(key);
            this.queued.set(key, { input, resolvers: [resolve] });
            this.send();
        });
    }

    dispose(): void {
        this.failures = 0;
        this.lastAnswer.clear();
        this.teardown();
    }

    private answer(job: Job<I, R> | undefined, result: R | undefined): void {
        for (const resolve of job?.resolvers ?? []) { resolve(result); }
    }

    private remember(key: string, input: I, result: R): void {
        if (!this.worthKeeping(result)) { return; }
        this.lastAnswer.delete(key);
        this.lastAnswer.set(key, { input, result });
        if (this.lastAnswer.size > MAX_REMEMBERED) { this.lastAnswer.delete(this.lastAnswer.keys().next().value!); }
    }

    private failAllPending(): void {
        this.answer(this.inFlight, undefined);
        this.inFlight = undefined;
        for (const job of this.queued.values()) { this.answer(job, undefined); }
        this.queued.clear();
    }

    private teardown(): void {
        const worker = this.worker;
        this.worker = undefined;
        this.failAllPending();
        void worker?.terminate();
    }

    private ensureWorker(): Worker | undefined {
        if (this.worker) { return this.worker; }
        if (this.failures >= MAX_CONSECUTIVE_FAILURES) { return undefined; }

        try {
            const worker = new Worker(this.workerPath);

            worker.on('message', (result: R) => {
                this.failures = 0;
                const pending = this.inFlight;
                this.inFlight = undefined;

                // A reply for anything but the current request is a leftover from a
                // worker that was replaced; ignore it.
                const current = pending !== undefined && pending.id === result.id;
                if (current) { this.remember(pending.key, pending.input, result); }
                this.answer(pending, current ? result : undefined);

                this.send();
            });

            // 'exit' fires after 'error' too, so both funnel into the same teardown
            // and the next caller gets a fresh worker.
            worker.on('error', () => { this.failures++; this.teardown(); });
            worker.on('exit',  () => { if (this.worker === worker) { this.teardown(); } });

            this.worker = worker;
            return worker;
        } catch {
            this.failures++;
            return undefined;
        }
    }

    /** Posts the oldest waiting job, if the worker is free and there is one. */
    private send(): void {
        if (this.inFlight || this.queued.size === 0) { return; }

        const worker = this.ensureWorker();
        if (!worker) { this.failAllPending(); return; }

        const [key, job] = this.queued.entries().next().value!;
        this.queued.delete(key);

        const id = this.nextId++;
        this.inFlight = { ...job, id, key };
        try {
            worker.postMessage({ ...job.input, id });
        } catch {
            this.inFlight = undefined;
            this.answer(job, undefined);
            this.teardown();
        }
    }
}

const jsWorker = new AnalysisWorker<{ text: string }, JsAnalysisResult>(
    path.join(__dirname, 'jsAnalysisWorker.js'),
    (a, b) => a.text === b.text,
    // An empty answer is also what a failed analysis looks like, so it is not
    // kept: asking again is the only way to recover from that.
    result => result.jsRanges.length > 0,
);

type AspColouringInput = Omit<AspColouringRequest, 'id'>;

const aspWorker = new AnalysisWorker<AspColouringInput, AspColouringResult>(
    path.join(__dirname, 'aspColouring.js'),
    // The include symbols come from a memo that hands back the same object
    // until the document or one of its includes changes.
    (a, b) => a.text === b.text && a.docPath === b.docPath && a.includeSymbols === b.includeSymbols,
    result => !result.failed,
);

/**
 * Classification spans and diagnostics for the JavaScript embedded in `text`,
 * the current text of the document `key` (its URI), or undefined when a newer
 * request for that document superseded this one or the worker could not answer.
 * Offsets in the result are in virtual-file space; subtract `preambleLength`
 * to get document offsets.
 */
export function analyseEmbeddedJs(key: string, text: string): Promise<JsAnalysisResult | undefined> {
    return jsWorker.request(key, { text });
}

/**
 * The VBScript and SQL colouring of the document `key` (its URI), and its SQL
 * warnings, or undefined when a newer request for that document superseded
 * this one or the worker could not answer.
 */
export function colourAspPage(
    key: string, text: string, docPath: string, includeSymbols: FileSymbols,
): Promise<AspColouringResult | undefined> {
    return aspWorker.request(key, { text, docPath, includeSymbols });
}

/** Shuts both workers down. Called from deactivate. */
export function disposeAnalysisWorkers(): void {
    jsWorker.dispose();
    aspWorker.dispose();
}
