/**
 * competingExtensions.ts
 *
 * Other Classic ASP extensions register the same `asp` language and the same
 * `text.html.asp` grammar as this one. VS Code keeps one grammar per scope, so
 * with two installed the colours come from whichever happened to load last,
 * and their snippets and completions are offered beside these. Most people who
 * see the odd colours never connect them to the second extension.
 *
 * Only the `asp` language id and the `text.html.asp` scope count. A file
 * extension does not: VS Code's own HTML support lists `.asp` and `.aspx`
 * among its file types, and so may any HTML-flavoured extension.
 *
 * On start-up, every enabled extension that claims ASP files is named in one
 * notification, with a button to uninstall it. VS Code has no command to
 * disable another extension, so a second button opens it in the Extensions
 * view, where Disable is one click. "Keep Both" is remembered per extension,
 * so one installed later is still pointed out.
 *
 * Closing the notification without an answer means "not now": it asks again
 * at the next start. Closed a second time, it is taken as Keep Both. (It used
 * to wait a week after a close, by which time nobody remembered why the
 * colours were odd.)
 */

import * as vscode from 'vscode';

const KEPT_KEY      = 'classicAsp.competingExtensions.kept';
/** The ones whose notification was closed once without an answer. */
const DISMISSED_KEY = 'classicAsp.competingExtensions.dismissed';
/** The week-long snooze this replaced; cleared when found. */
const OLD_SNOOZE_KEY = 'classicAsp.competingExtensions.askAgainAt';

/** The parts of an installed extension this reads. */
export interface ExtensionLike { id: string; packageJSON: any }

export interface Competitor { id: string; name: string }

/** Whether a manifest registers the asp language, or the grammar this extension uses for it. */
export function claimsAsp(manifest: any): boolean {
    const contributes = manifest?.contributes ?? {};
    const languages: any[] = Array.isArray(contributes.languages) ? contributes.languages : [];
    const grammars:  any[] = Array.isArray(contributes.grammars)  ? contributes.grammars  : [];
    return languages.some(l => String(l?.id ?? '').toLowerCase() === 'asp')
        || grammars.some(g => g?.scopeName === 'text.html.asp' || String(g?.language ?? '').toLowerCase() === 'asp');
}

/** The other extensions in `all` that claim ASP files, by display name. VS Code's own are never counted. */
export function findCompetitors(all: readonly ExtensionLike[], selfId: string): Competitor[] {
    const self = selfId.toLowerCase();
    return all
        .filter(e => e.id.toLowerCase() !== self && !e.id.toLowerCase().startsWith('vscode.') && claimsAsp(e.packageJSON))
        .map(e => ({ id: e.id, name: String(e.packageJSON?.displayName || e.id) }));
}

/** The competitors still worth a notification, given what was answered before. */
export function competitorsToMention(found: readonly Competitor[], kept: readonly string[]): Competitor[] {
    const keep = new Set(kept.map(id => id.toLowerCase()));
    return found.filter(c => !keep.has(c.id.toLowerCase()));
}

/**
 * What closing the notification without an answer leaves: each extension
 * closed on for the first time is remembered as dismissed, and one dismissed
 * before is now kept.
 */
export function afterDismissal(
    mentioned: readonly Competitor[], kept: readonly string[], dismissed: readonly string[],
): { kept: string[]; dismissed: string[] } {
    const before = new Set(dismissed.map(id => id.toLowerCase()));
    const ids = mentioned.map(c => c.id.toLowerCase());
    return {
        kept:      [...kept, ...ids.filter(id => before.has(id))],
        dismissed: [...dismissed, ...ids.filter(id => !before.has(id))],
    };
}

function nameList(competitors: readonly Competitor[]): string {
    const names = competitors.map(c => `"${c.name}"`);
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

async function uninstall(competitors: readonly Competitor[]): Promise<void> {
    const removed: Competitor[] = [];
    const failed:  Competitor[] = [];
    for (const c of competitors) {
        try {
            await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', c.id);
            removed.push(c);
        } catch {
            failed.push(c);
        }
    }
    // Both notices at once: neither should wait for an answer to the other.
    if (removed.length > 0) {
        const reload = 'Reload Window';
        void vscode.window.showInformationMessage(
            `Classic ASP: ${nameList(removed)} ${removed.length === 1 ? 'was' : 'were'} uninstalled. Reload the window to finish.`,
            reload,
        ).then(choice => {
            if (choice === reload) { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
        });
    }
    if (failed.length > 0) {
        const show = 'Show in Extensions';
        void vscode.window.showWarningMessage(
            `Classic ASP: ${nameList(failed)} could not be uninstalled from here. Disable or uninstall ${failed.length === 1 ? 'it' : 'them'} in the Extensions view.`,
            show,
        ).then(choice => {
            if (choice === show) { showInExtensions(failed); }
        });
    }
}

function showInExtensions(competitors: readonly Competitor[]): void {
    if (competitors.length === 1) {
        void vscode.commands.executeCommand('extension.open', competitors[0].id);
    } else {
        void vscode.commands.executeCommand('workbench.extensions.search', '@installed asp');
    }
}

/** Points out other enabled extensions that claim ASP files, and offers to remove them. */
export async function checkForCompetingExtensions(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get(OLD_SNOOZE_KEY) !== undefined) { await context.globalState.update(OLD_SNOOZE_KEY, undefined); }
    const kept      = context.globalState.get<string[]>(KEPT_KEY, []);
    const dismissed = context.globalState.get<string[]>(DISMISSED_KEY, []);
    const found     = findCompetitors(vscode.extensions.all, context.extension.id);
    const mention   = competitorsToMention(found, kept);
    if (mention.length === 0) { return; }

    const one       = mention.length === 1;
    const removeBtn = one ? 'Uninstall It' : 'Uninstall Them';
    const showBtn   = 'Show in Extensions';
    const keepBtn   = 'Keep Both';
    const choice = await vscode.window.showInformationMessage(
        `Classic ASP: ${nameList(mention)} ${one ? 'is' : 'are'} also installed. ` +
        `This extension already highlights Classic ASP, and with both enabled ` +
        `they fight over how .asp files are coloured.`,
        removeBtn, showBtn, keepBtn,
    );

    if (choice === removeBtn) {
        await uninstall(mention);
    } else if (choice === showBtn) {
        showInExtensions(mention);
    } else if (choice === keepBtn) {
        await context.globalState.update(KEPT_KEY, [...kept, ...mention.map(c => c.id.toLowerCase())]);
    } else {
        // Closed without an answer: ask again next start, and once only.
        const next = afterDismissal(mention, kept, dismissed);
        await context.globalState.update(KEPT_KEY, next.kept);
        await context.globalState.update(DISMISSED_KEY, next.dismissed);
    }
}
