/**
 * serveWorker.ts
 *
 * The one way a worker thread answers: every worker entry calls serveWorker
 * with what to work out and what to send when that fails.
 *
 * A request that throws costs that one answer, not the worker: the fallback is
 * sent instead, marked `failed`, with the error as text so the extension host
 * can write it to the log (a worker has no vscode module, so no log of its own).
 *
 * Imported anywhere but a worker thread (the tests do), parentPort is null and
 * this does nothing.
 */

import { parentPort, type TransferListItem } from 'node:worker_threads';

/** What every worker answer carries besides its own fields. */
export interface WorkerAnswer {
    id: number;
    /** True when the work threw and this is the fallback. */
    failed?: boolean;
    /** What was thrown, for the log. */
    error?: string;
}

export function serveWorker<Request extends { id: number }, Answer extends WorkerAnswer>(
    work: (request: Request) => Answer | Promise<Answer>,
    fallback: (request: Request) => Omit<Answer, 'failed' | 'error'>,
    /** Buffers handed over rather than copied, such as a large token array. */
    transfer: (answer: Answer) => TransferListItem[] = () => [],
): void {
    parentPort?.on('message', async (request: Request) => {
        let answer: Answer;
        try {
            answer = await work(request);
        } catch (error) {
            const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
            answer = { ...fallback(request), id: request.id, failed: true, error: text } as Answer;
        }
        parentPort?.postMessage(answer, transfer(answer));
    });
}
