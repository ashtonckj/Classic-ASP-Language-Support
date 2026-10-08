/**
 * guardedProvider.ts
 *
 * The part of the provider contract that is the same for every provider, put
 * on each one where it is registered rather than written into each method:
 *
 *   • a request already cancelled is answered with nothing at once;
 *   • an unexpected error is written to the Classic ASP log (once) and the
 *     answer is nothing, instead of an exception thrown into VS Code, which
 *     shows the user nothing useful and, under a debugger, stops the
 *     Extension Host.
 *
 * Only the methods VS Code calls for an answer are guarded — provide…,
 * resolve…, prepare… — so an event such as onDidChangeSemanticTokens is left
 * as it is. A method whose errors are meant for the user (rename's "this
 * cannot be renamed") is named in `userErrors` and still throws.
 */

import type * as vscode from 'vscode';
import { log } from './log';

const ANSWERING = /^(provide|resolve|prepare)/;

function isCancellationToken(value: unknown): value is vscode.CancellationToken {
    return typeof value === 'object' && value !== null
        && typeof (value as vscode.CancellationToken).isCancellationRequested === 'boolean'
        && typeof (value as vscode.CancellationToken).onCancellationRequested === 'function';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}

export interface GuardOptions<P> {
    /** Methods whose thrown errors VS Code shows to the user, so they are passed on. */
    userErrors?: ReadonlyArray<keyof P & string>;
}

/** `provider`, with every answering method guarded as described above; `name` is how the log names it. */
export function guarded<P extends object>(name: string, provider: P, options: GuardOptions<P> = {}): P {
    const passOn = new Set<string>(options.userErrors ?? []);

    return new Proxy(provider, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof property !== 'string' || typeof value !== 'function' || !ANSWERING.test(property)) { return value; }

            const failed = (error: unknown): undefined => {
                if (passOn.has(property)) { throw error; }
                log.error(`${name}: ${property} failed`, error);
                return undefined;
            };

            return (...args: unknown[]) => {
                if (args.some(arg => isCancellationToken(arg) && arg.isCancellationRequested)) { return undefined; }
                try {
                    const answer: unknown = value.apply(target, args);
                    return isThenable(answer) ? Promise.resolve(answer).catch(failed) : answer;
                } catch (error) {
                    return failed(error);
                }
            };
        },
    });
}
