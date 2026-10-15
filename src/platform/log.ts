/**
 * log.ts
 *
 * The extension's one log: the "Classic ASP" channel in the Output panel. It
 * is a log channel, so each line carries its time and level, and the user's
 * log level decides what shows.
 *
 * Nothing here opens the channel on its own: a message the user should see
 * gets a "Show Details" button that calls showLog, and everything else just
 * waits in the log for whoever goes looking.
 */

import * as vscode from 'vscode';

const CHANNEL_NAME = 'Classic ASP';

let channel: vscode.LogOutputChannel | undefined;

/** Created on first use, so a window that never logs has no empty channel in its Output list. */
function output(): vscode.LogOutputChannel {
    return (channel ??= vscode.window.createOutputChannel(CHANNEL_NAME, { log: true }));
}

/** Messages already logged as errors, so one failing on every keystroke is written once. */
const loggedErrors = new Set<string>();

function describe(error: unknown): string {
    return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
}

export const log = {
    info(message: string): void { output().info(message); },
    warn(message: string): void { output().warn(message); },
    /** An error, with what went wrong; the same message and error are written only once per session. */
    error(message: string, error?: unknown): void {
        const text = error === undefined ? message : `${message}\n${describe(error)}`;
        if (loggedErrors.has(text)) { return; }
        loggedErrors.add(text);
        output().error(text);
    },
};

/** Opens the log, for a "Show Details" button. */
export function showLog(): void {
    output().show(true);
}

export function disposeLog(): void {
    channel?.dispose();
    channel = undefined;
    loggedErrors.clear();
}
