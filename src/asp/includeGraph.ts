/**
 * includeGraph.ts  (asp/)
 *
 * Which pages include which, over the whole workspace. Go to Definition, hover
 * and rename ask it, because a name in an include is often declared by the
 * page that includes it.
 *
 * It used to be worked out when asked: every ASP file of the workspace read,
 * and every include checked on disk, on the extension host, again whenever five
 * seconds had passed — 35 ms for a 100-file site on a local disk, and seconds
 * on the network shares IIS sites often live on, each time a Ctrl+hover landed
 * on a name the page does not declare. Now each file's includes are read once,
 * in the background, and the workspace index's watcher keeps them current. An
 * open page with unsaved changes counts as its buffer says.
 *
 * Rename asks for a fresh read (`fresh`): a watcher can miss a change on a
 * network share, and a page missing from the graph is a page the rename would
 * leave unchanged. Asked before the background read is done, the graph is read
 * there and then, as before.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseIncludeDirectives, resolveIncludeDirective } from '../core/includeDirectives';
import { pathKey, withoutBom } from '../core/paths';
import { aspFiles, getWorkspaceAspFiles, onAspFilesChange } from '../platform/workspaceIndex';
import { onSettingsChange } from '../platform/settings';
import { getVirtualRoot, readIncludeText } from './includeProvider';

/** A file and the files it includes directly, as path keys, whether or not they exist. */
interface Entry {
    path:     string;
    includes: string[];
}

/** By path key. Complete once `complete` is set; until then a query reads the workspace itself. */
let entries = new Map<string, Entry>();
let complete = false;
/** Bumped on every change, so a reverse graph built earlier is not reused. */
let generation = 0;
/** Bumped when the include paths resolve differently, so a background read under way is dropped. */
let readEpoch = 0;
/** Files deleted while the background read is under way, which it may already have read. */
let deletedDuringRead = new Set<string>();
/** The reverse graph last built, and what it was built from. */
let lastIncludedBy: { key: string; includedBy: Map<string, string[]> } | null = null;

function entryOf(fsPath: string, text: string): Entry {
    const root = getVirtualRoot(fsPath);
    return {
        path: fsPath,
        includes: parseIncludeDirectives(text).map(directive => pathKey(resolveIncludeDirective(directive, fsPath, root))),
    };
}

function changed(): void {
    generation++;
    lastIncludedBy = null;
}

/** Every file of the workspace read again now, on this thread. */
function readAllNow(): void {
    const next = new Map<string, Entry>();
    for (const fsPath of getWorkspaceAspFiles()) { next.set(pathKey(fsPath), entryOf(fsPath, readIncludeText(fsPath) ?? '')); }
    entries = next;
    complete = true;
    changed();
}

/**
 * Every file of the workspace read without blocking. A file the watcher saw
 * change meanwhile is already in `entries`, newer than what this read, so it
 * wins; giving up instead left the graph incomplete until a query read the
 * whole workspace on the extension host.
 */
async function readAllInBackground(): Promise<void> {
    const started = readEpoch;
    const next = new Map<string, Entry>();
    for (const fsPath of await aspFiles()) {
        let text: string;
        try { text = withoutBom(await fs.promises.readFile(fsPath, 'utf8')); } catch { continue; }
        next.set(pathKey(fsPath), entryOf(fsPath, text));
        if (readEpoch !== started) { return; }
    }
    if (readEpoch !== started || complete) { return; }
    for (const key of deletedDuringRead) { next.delete(key); }
    for (const [key, entry] of entries) { next.set(key, entry); }
    deletedDuringRead = new Set();
    entries = next;
    complete = true;
    changed();
}

async function reread(files: string[]): Promise<void> {
    for (const fsPath of files) {
        let text: string;
        try { text = withoutBom(await fs.promises.readFile(fsPath, 'utf8')); } catch { continue; }
        entries.set(pathKey(fsPath), entryOf(fsPath, text));
        deletedDuringRead.delete(pathKey(fsPath));
        changed();
    }
}

/** Forgets everything: the include paths resolve differently now. */
function startAgain(): void {
    entries = new Map();
    deletedDuringRead = new Set();
    complete = false;
    readEpoch++;
    changed();
    void readAllInBackground();
}

/**
 * Starts reading the workspace's includes in the background, a few seconds
 * after the extension starts, and keeps them current from the watcher.
 */
export function registerIncludeGraph(context: vscode.ExtensionContext): void {
    entries = new Map();
    deletedDuringRead = new Set();
    complete = false;
    readEpoch++;
    changed();
    const timer = setTimeout(() => { if (!complete) { void readAllInBackground(); } }, 3000);
    context.subscriptions.push(
        { dispose: () => clearTimeout(timer) },
        onAspFilesChange(change => {
            if (change.created.length + change.changed.length + change.deleted.length === 0) { startAgain(); return; }
            for (const fsPath of change.deleted) {
                entries.delete(pathKey(fsPath));
                if (!complete) { deletedDuringRead.add(pathKey(fsPath)); }
            }
            changed();
            void reread([...change.created, ...change.changed]);
        }),
        onSettingsChange(['classicAsp.virtualRoot'], startAgain),
        vscode.workspace.onDidChangeWorkspaceFolders(startAgain),
    );
}

/**
 * Which files include each file directly, by the included file's path key.
 * `document` and every other open page with unsaved changes count as their
 * buffers say; `fresh` reads every other file again first.
 */
export function includedByMap(document: vscode.TextDocument, fresh = false): Map<string, string[]> {
    if (fresh || !complete) { readAllNow(); }

    const unsaved = vscode.workspace.textDocuments.filter(doc =>
        doc === document || (doc.isDirty && doc.languageId === 'asp' && doc.uri.scheme === 'file'));
    const key = `${generation}|` + unsaved.map(doc => `${doc.uri.toString()}@${doc.version}`).join('|');
    if (lastIncludedBy?.key === key) { return lastIncludedBy.includedBy; }

    const current = new Map(entries);
    for (const doc of unsaved) { current.set(pathKey(doc.uri.fsPath), entryOf(doc.uri.fsPath, doc.getText())); }

    const includedBy = new Map<string, string[]>();
    for (const { path, includes } of current.values()) {
        for (const target of new Set(includes)) {
            const list = includedBy.get(target);
            if (list) { list.push(path); } else { includedBy.set(target, [path]); }
        }
    }
    lastIncludedBy = { key, includedBy };
    return includedBy;
}
