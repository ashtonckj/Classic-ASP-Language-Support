/**
 * analysisClient.ts  (workers/)
 *
 * The extension-host side of the page-analysis workers:
 *
 *   • jsAnalysisWorker.ts   — the JavaScript service: the type-aware colouring,
 *     the squiggles and the Outline from one TypeScript pass, and every
 *     JavaScript query (completion, hover, rename…);
 *   • aspColouringWorker.ts — the VBScript and SQL colouring, and the SQL warnings;
 *   • vbscriptWorker.ts     — the VBScript page's symbols and blocks, its checks,
 *     and the symbols of its include tree.
 *
 * Each is a long-lived worker thread of its own, so none waits behind another,
 * and all are driven the same way:
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
 *   • A job someone is waiting on goes first (`urgent`), and stops the
 *     background job under way, which is worked out again after it. A worker
 *     sees that through workerData.cancel, an Int32Array over memory both
 *     threads share: it reads no message while busy in one long call.
 *
 *   • A caller that stops waiting (its CancellationToken) is answered with
 *     undefined at once; a job nobody waits on any more is dropped, or stopped.
 *
 *   • The same input is worked out once. A second request for input already
 *     waiting or being worked on shares that answer instead of displacing it,
 *     and one for the input answered last is given that answer again.
 *
 *   • Never reject. Every caller is a decoration path — colours and squiggles.
 *     A worker that dies must cost a refresh, not surface an extension error to
 *     the user, so every failure resolves to undefined and the next call starts
 *     a fresh worker. Every failure is written to the log, and so is a worker
 *     given up on.
 *
 * When a worker cannot run at all: the VBScript work is done on the extension
 * host instead (vbscriptWorkspace.ts), and so is the JavaScript Outline, which
 * needs only a parse; the rest of the JavaScript features, the VBScript/SQL
 * colouring and squiggles, and the include symbols completion offers, are left
 * off, as working them out on the host is what slowed typing down before the
 * workers existed.
 */

import * as path from 'path';
import { Worker } from 'node:worker_threads';
import type * as vscode from 'vscode';
import { log } from '../platform/log';
import type { WorkerAnswer } from './serveWorker';
import type { JsAnalysisResult, JsQueryAnswer, JsQueryMethod, JsWorkerRequest } from './jsAnalysisWorker';
import type { JsLanguageService } from '../js/jsUtils';
import type { AspColouringRequest, AspColouringResult } from '../vbscript/aspColouring';
import type { FileSymbols } from '../vbscript/symbolParser';
import type { ChecksResult, IncludesResult, PageResult } from './vbscriptWorker';
import type { PageAnalysis } from '../vbscript/pageAnalysis';
import type { IncludeFile, PageChecks, ScopeRequest } from '../vbscript/pageChecks';

export type { JsAnalysisResult, PlainJsDiagnostic } from './jsAnalysisWorker';
export type { AspColouringResult, SqlWarning } from '../vbscript/aspColouring';

// A worker that cannot start is usually a packaging problem, which retrying
// will not solve. Stop respawning after this many consecutive failures and
// leave the feature off rather than spawning a thread per keystroke forever.
const MAX_CONSECUTIVE_FAILURES = 3;

// A job not answered in this long is taken as a worker stuck in a loop: it is
// stopped, so the next request starts a fresh one instead of waiting forever.
const JOB_TIMEOUT_MS = 30_000;

// Answers kept for reuse, for the most recent documents only.
const MAX_REMEMBERED = 8;

type Resolver<R> = (result: R | undefined) => void;

interface Job<I, R> { input: I; resolvers: Resolver<R>[]; }

/** A long-lived worker thread and the requests waiting for it. */
export class AnalysisWorker<I extends object, R extends WorkerAnswer> {
    private worker: Worker | undefined;
    private nextId   = 1;
    private failures = 0;
    private inFlight: (Job<I, R> & { id: number; key: string }) | undefined;
    // Waiting jobs, at most one per document, in the order they were asked for.
    private readonly queued = new Map<string, Job<I, R>>();
    private readonly lastAnswer = new Map<string, { input: I; result: R }>();
    private jobTimer: ReturnType<typeof setTimeout> | undefined;
    // Set to 1 to ask the worker to stop its job (cancelInFlight); every worker
    // started gets it as workerData.cancel.
    private readonly cancelFlag = new Int32Array(new SharedArrayBuffer(4));

    constructor(
        /** What the worker does, for the log: "VBScript analysis". */
        private readonly name: string,
        private readonly workerPath: string,
        /** True when two requests would get the same answer. */
        private readonly sameInput: (a: I, b: I) => boolean,
        /** False for an answer that may be a failure in disguise, which is not kept. */
        private readonly worthKeeping: (result: R) => boolean,
        /** True for a job to send ahead of the others waiting. */
        private readonly urgent: (input: I) => boolean = () => false,
        private readonly jobTimeoutMs = JOB_TIMEOUT_MS,
    ) {}

    /**
     * The answer for `input`, the current input of `key` (a document's URI,
     * or a kind of question about it), or undefined when a newer request for
     * `key` superseded it, `token` was cancelled, or the worker could not answer.
     */
    request(key: string, input: I, token?: vscode.CancellationToken): Promise<R | undefined> {
        return new Promise<R | undefined>(resolve => {
            if (token?.isCancellationRequested) { resolve(undefined); return; }
            let settled = false;
            let listener: vscode.Disposable | undefined;
            const done: Resolver<R> = result => { settled = true; listener?.dispose(); resolve(result); };
            this.enqueue(key, input, done);
            if (token && !settled) { listener = token.onCancellationRequested(() => this.withdraw(done)); }
        });
    }

    private enqueue(key: string, input: I, resolve: Resolver<R>): void {
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

        // Newest wins for this key: what was waiting is already out of date.
        // It moves to the back, behind any other key's request.
        this.answer(waiting, undefined);
        this.queued.delete(key);
        this.queued.set(key, { input, resolvers: [resolve] });

        // Someone is waiting on an urgent job; the background one under way is
        // stopped, to be worked out again after.
        if (this.urgent(input) && this.inFlight && !this.urgent(this.inFlight.input)) { this.cancelInFlight(); }
        this.send();
    }

    /** Answers a cancelled caller with undefined, and drops its job once nobody waits on it. */
    private withdraw(resolve: Resolver<R>): void {
        for (const [key, job] of this.queued) {
            if (!job.resolvers.includes(resolve)) { continue; }
            job.resolvers = job.resolvers.filter(r => r !== resolve);
            if (job.resolvers.length === 0) { this.queued.delete(key); }
            resolve(undefined);
            return;
        }
        const job = this.inFlight;
        if (job?.resolvers.includes(resolve)) {
            job.resolvers = job.resolvers.filter(r => r !== resolve);
            if (job.resolvers.length === 0) { this.cancelInFlight(); }
            resolve(undefined);
        }
    }

    /**
     * Asks the worker to stop the job under way. A worker is busy inside one
     * synchronous call and reads no messages until it ends, so the request goes
     * through memory both threads share; a worker that does not read it just
     * finishes the job.
     */
    private cancelInFlight(): void {
        Atomics.store(this.cancelFlag, 0, 1);
    }

    /** False once the worker has failed to start too often to try again. */
    get usable(): boolean {
        return this.failures < MAX_CONSECUTIVE_FAILURES;
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
        clearTimeout(this.jobTimer);
        const worker = this.worker;
        this.worker = undefined;
        this.failAllPending();
        void worker?.terminate();
    }

    private ensureWorker(): Worker | undefined {
        if (this.worker) { return this.worker; }
        if (this.failures >= MAX_CONSECUTIVE_FAILURES) { return undefined; }

        try {
            const worker = new Worker(this.workerPath, { workerData: { cancel: this.cancelFlag } });

            worker.on('message', (result: R) => {
                // A worker torn down can still post what it was working on; it
                // must not answer, or free the slot of, the job its successor has.
                if (this.worker !== worker) { return; }
                clearTimeout(this.jobTimer);
                this.failures = 0;
                if (result.error) { log.error(`The ${this.name} worker failed on a page`, result.error); }
                const pending = this.inFlight;
                this.inFlight = undefined;

                // A reply for anything but the current request is a leftover from a
                // worker that was replaced; ignore it.
                const current = pending !== undefined && pending.id === result.id;
                if (current && result.cancelled) {
                    // Stopped for an urgent job: worked out again after it, unless
                    // nobody waits any more or a newer request has taken its place.
                    if (pending.resolvers.length > 0 && !this.urgent(pending.input) && !this.queued.has(pending.key)) {
                        this.queued.set(pending.key, pending);
                    } else {
                        this.answer(pending, undefined);
                    }
                } else {
                    if (current) { this.remember(pending.key, pending.input, result); }
                    this.answer(pending, current ? result : undefined);
                }

                this.send();
            });

            // 'exit' fires after 'error' too, so both funnel into the same teardown
            // and the next caller gets a fresh worker.
            worker.on('error', error => {
                this.failures++;
                log.error(`The ${this.name} worker stopped`, error);
                if (this.failures === MAX_CONSECUTIVE_FAILURES) { log.warn(`The ${this.name} worker failed ${this.failures} times in a row, so it is not started again.`); }
                this.teardown();
            });
            worker.on('exit',  () => { if (this.worker === worker) { this.teardown(); } });

            this.worker = worker;
            return worker;
        } catch (error) {
            this.failures++;
            log.error(`The ${this.name} worker could not start`, error);
            return undefined;
        }
    }

    /** Posts the oldest waiting job, if the worker is free and there is one. */
    private send(): void {
        if (this.inFlight || this.queued.size === 0) { return; }

        const worker = this.ensureWorker();
        if (!worker) { this.failAllPending(); return; }

        const [key, job] = [...this.queued.entries()].find(([, waiting]) => this.urgent(waiting.input))
            ?? this.queued.entries().next().value!;
        this.queued.delete(key);

        const id = this.nextId++;
        this.inFlight = { ...job, id, key };
        this.jobTimer = setTimeout(() => {
            this.failures++;
            log.warn(`The ${this.name} worker gave no answer in ${this.jobTimeoutMs / 1000} s, so it was stopped.`);
            this.teardown();
        }, this.jobTimeoutMs);
        Atomics.store(this.cancelFlag, 0, 0);
        try {
            worker.postMessage({ ...job.input, id });
        } catch {
            this.inFlight = undefined;
            this.answer(job, undefined);
            this.teardown();
        }
    }
}

const jsWorker = new AnalysisWorker<Omit<JsWorkerRequest, 'id'>, JsAnalysisResult | JsQueryAnswer>(
    'JavaScript',
    path.join(__dirname, 'jsAnalysisWorker.js'),
    // Only an analysis is shared or kept: a query is asked when it is needed.
    (a, b) => !a.query && !b.query && a.text === b.text,
    // An empty answer is also what a failed analysis looks like, so it is not
    // kept: asking again is the only way to recover from that.
    result => 'jsRanges' in result && result.jsRanges.length > 0,
    // Someone is waiting on a query.
    input => input.query !== undefined,
);

type AspColouringInput = Omit<AspColouringRequest, 'id'>;

const aspWorker = new AnalysisWorker<AspColouringInput, AspColouringResult>(
    'VBScript colouring',
    path.join(__dirname, 'aspColouringWorker.js'),
    // The include symbols come from a memo that hands back the same object
    // until the document or one of its includes changes.
    (a, b) => a.text === b.text && a.docPath === b.docPath && a.includeSymbols === b.includeSymbols,
    result => !result.failed,
);

type VbscriptInput =
    | { kind: 'page'; text: string; docPath: string }
    | (ScopeRequest & { kind: 'checks' })
    | (ScopeRequest & { kind: 'includes' });

const vbscriptWorker = new AnalysisWorker<VbscriptInput, PageResult | ChecksResult | IncludesResult>(
    'VBScript analysis',
    path.join(__dirname, 'vbscriptWorker.js'),
    // Checks and includes read files from disk, which may have changed since,
    // so only a page's own reading is shared. includeProvider already shares
    // an include load under way for the same includes.
    (a, b) => a.kind === 'page' && b.kind === 'page' && a.text === b.text && a.docPath === b.docPath,
    result => !result.failed && 'symbols' in result,
    // What completion is waiting on goes before checks nobody is waiting on.
    input => input.kind !== 'checks',
);

/**
 * Classification spans, diagnostics and the Outline for the JavaScript
 * embedded in `text`, the current text of the document `key` (its URI), or
 * undefined when a newer request for that document superseded this one,
 * `token` was cancelled, or the worker could not answer. Offsets in the result
 * are page offsets.
 */
export function analyseEmbeddedJs(key: string, text: string, token?: vscode.CancellationToken): Promise<JsAnalysisResult | undefined> {
    return jsWorker.request(key, { text }, token) as Promise<JsAnalysisResult | undefined>;
}

/**
 * What the JavaScript service's `method` answers about `text`, the current
 * text of the document `key` (its URI), at page offsets; undefined when a newer
 * query of the same kind for that document superseded this one, `token` was
 * cancelled, or the worker could not answer.
 */
export async function queryEmbeddedJs<M extends JsQueryMethod>(
    key: string, text: string, method: M, args: Parameters<JsLanguageService[M]>, token?: vscode.CancellationToken,
): Promise<ReturnType<JsLanguageService[M]> | undefined> {
    // Keyed by kind, so a hover does not displace a completion, nor either an analysis.
    const answer = await jsWorker.request(`${method}:${key}`, { text, query: { method, args } }, token) as JsQueryAnswer | undefined;
    return answer?.value as ReturnType<JsLanguageService[M]> | undefined;
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

/**
 * The symbols and blocks of `text`, the text of the document `key` (its URI),
 * or undefined when a newer request for that document superseded this one or
 * the worker could not answer.
 */
export async function analyseVbscriptPage(key: string, text: string, docPath: string): Promise<PageAnalysis | undefined> {
    const result = await vbscriptWorker.request(key, { kind: 'page', text, docPath }) as PageResult | undefined;
    return result && !result.failed ? result : undefined;
}

/**
 * Missing Set and the parser's checks for the document `key` (its URI), or
 * undefined when a newer request for that document superseded this one or
 * the worker could not answer.
 */
export async function checkVbscriptPage(key: string, request: ScopeRequest): Promise<PageChecks | undefined> {
    const result = await vbscriptWorker.request(`checks:${key}`, { ...request, kind: 'checks' }) as ChecksResult | undefined;
    return result && !result.failed ? result : undefined;
}

/**
 * Every file the page of `request` includes, each with its symbols and the
 * includes it names, or undefined when a newer load for the same `key`
 * superseded this one or the worker could not answer.
 */
export async function loadIncludeTree(key: string, request: ScopeRequest): Promise<IncludeFile[] | undefined> {
    const result = await vbscriptWorker.request(`includes:${key}`, { ...request, kind: 'includes' }) as IncludesResult | undefined;
    return result && !result.failed ? result.entries : undefined;
}

/** False when the JavaScript worker cannot run; the Outline is then worked out on the host, and the rest is off. */
export function jsWorkerUsable(): boolean {
    return jsWorker.usable;
}

/** False when the VBScript worker cannot run, and the host has to read pages itself. */
export function vbscriptWorkerUsable(): boolean {
    return vbscriptWorker.usable;
}

/** Shuts the workers down. Called from deactivate. */
export function disposeAnalysisWorkers(): void {
    jsWorker.dispose();
    aspWorker.dispose();
    vbscriptWorker.dispose();
}
