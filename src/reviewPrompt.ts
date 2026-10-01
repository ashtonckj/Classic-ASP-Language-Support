/**
 * reviewPrompt.ts
 *
 * Asks for a rating, at most twice ever, and only from someone who has used
 * the extension for a while: no sooner than a week after it first started,
 * and right after a successful Format Document — the fifth since then — so
 * it lands when the extension has just done something useful, never on
 * start-up or in the middle of an error.
 *
 * "Rate It" and "Don't Ask Again" end it for good. "Later", or closing the
 * notification, asks once more, a month and five more formats on.
 *
 * The rating page is the Visual Studio Marketplace in VS Code, and Open VSX
 * in the editors that install from there (VSCodium, Cursor and the like).
 */

import * as vscode from 'vscode';

const STATE_KEY = 'classicAsp.reviewPrompt';
const DAY       = 24 * 60 * 60 * 1000;

export const FIRST_WAIT_DAYS = 7;
export const LATER_WAIT_DAYS = 30;
export const FORMATS_NEEDED  = 5;
export const MAX_ASKS        = 2;

export interface ReviewState {
    /** Formats since the state began, or since the last time it asked. */
    formats: number;
    /** How many times it has asked. */
    asked: number;
    /** Not to ask before this time. */
    askAfter: number;
    /** Rated, or asked never to be asked. */
    done: boolean;
}

export type ReviewChoice = 'rate' | 'later' | 'never' | undefined;

export function initialState(now: number): ReviewState {
    return { formats: 0, asked: 0, askAfter: now + FIRST_WAIT_DAYS * DAY, done: false };
}

/** The state after one more successful format. */
export function countFormat(state: ReviewState): ReviewState {
    return { ...state, formats: state.formats + 1 };
}

export function isTimeToAsk(state: ReviewState, now: number): boolean {
    return !state.done && state.asked < MAX_ASKS && now >= state.askAfter && state.formats >= FORMATS_NEEDED;
}

/** The state after the user answered — undefined being a notification closed unanswered. */
export function afterAnswer(state: ReviewState, choice: ReviewChoice, now: number): ReviewState {
    if (choice === 'rate' || choice === 'never') { return { ...state, asked: state.asked + 1, done: true }; }
    return { formats: 0, asked: state.asked + 1, askAfter: now + LATER_WAIT_DAYS * DAY, done: false };
}

/** Where to rate the extension, given the editor it runs in. */
export function ratingPage(appName: string, publisher: string, name: string): { url: string; site: string } {
    if (/visual studio code/i.test(appName)) {
        return {
            url:  `https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}&ssr=false#review-details`,
            site: 'the Marketplace',
        };
    }
    return { url: `https://open-vsx.org/extension/${publisher}/${name}/reviews`, site: 'Open VSX' };
}

export class ReviewPrompt {
    private asking = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        // A rating given on one machine should not be asked for on the next.
        context.globalState.setKeysForSync([STATE_KEY]);
    }

    private read(): ReviewState {
        return this.context.globalState.get<ReviewState>(STATE_KEY) ?? initialState(Date.now());
    }

    /** Called after each successful Format Document; asks when the time has come. */
    async formatted(): Promise<void> {
        if (this.context.extensionMode === vscode.ExtensionMode.Test) { return; }
        let state = countFormat(this.read());
        await this.context.globalState.update(STATE_KEY, state);
        if (this.asking || !isTimeToAsk(state, Date.now())) { return; }

        this.asking = true;
        try {
            const manifest = this.context.extension.packageJSON;
            const page     = ratingPage(vscode.env.appName, manifest.publisher, manifest.name);
            const rate = 'Rate It', later = 'Later', never = "Don't Ask Again";
            const answer = await vscode.window.showInformationMessage(
                `Classic ASP: if the extension is saving you time, a rating on ${page.site} ` +
                `helps other Classic ASP developers find it. It takes a minute.`,
                rate, later, never,
            );
            const choice: ReviewChoice = answer === rate ? 'rate' : answer === never ? 'never' : answer === later ? 'later' : undefined;

            // Read again: another window may have counted formats meanwhile.
            state = afterAnswer(this.read(), choice, Date.now());
            await this.context.globalState.update(STATE_KEY, state);
            if (choice === 'rate') { void vscode.env.openExternal(vscode.Uri.parse(page.url)); }
        } finally {
            this.asking = false;
        }
    }
}
