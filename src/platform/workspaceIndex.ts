/**
 * workspaceIndex.ts  (platform/)
 *
 * Every ASP file in the workspace folders: by extension (.asp, .inc …) or
 * through the user's own `files.associations` (a site that keeps its Classic
 * ASP in .html files). Ctrl+T, rename and the include graph read the list.
 *
 * The folders are walked once and a file watcher keeps the list current from
 * then on, and tells the features that keep something per file (Ctrl+T's
 * symbols, the include graph) which files changed.
 *
 * The watcher watches `**\/*`, not the ASP patterns: a folder deleted or copied
 * in whole arrives as ONE event for the folder, which a `**\/*.asp` pattern
 * never matches, and its files would stay listed (or never be listed). VS Code
 * already watches the workspace for the Explorer, so this adds no OS watcher;
 * what it costs is an event per file, so a handler does no file system work
 * for a name that is not an ASP file, and awaits what it does do.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { onSettingsChange, otherSetting } from './settings';

/** The extensions this extension's package.json registers for the "asp" language, read live. Falls back to the current ones under the unit-test stub. */
function getAspFileExtensions(): string[] {
    const languages = vscode.extensions.getExtension('ashtonckj.classic-asp-language-support')
        ?.packageJSON?.contributes?.languages as { id: string; extensions?: string[] }[] | undefined;
    const extensions = languages?.find(l => l.id === 'asp')?.extensions;
    return (extensions && extensions.length > 0 ? extensions : ['.asp', '.inc']).map(e => e.toLowerCase());
}

export interface AssociationRule { matcher: RegExp; matchesFullPath: boolean; }

/** Escapes one glob-pattern character. Passed to String.replace on a single character at a time, so it either returns the escaped form or the character itself when it needs no escaping. */
function escapeGlobChar(c: string): string {
    return /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
}

// Converts a `files.associations` glob (e.g. `*.html`, or a double-star
// pattern reaching into subfolders, or `lib/*.asp`) into a RegExp. Supports
// `*` (any run of non-separator characters), a double-star (any run of
// characters, including separators), and `?` (one character) — the subset
// that covers the patterns users actually write for this setting.
export function globToRegExp(glob: string): RegExp {
    let pattern = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            pattern += '.*';
            i++;
            if (glob[i + 1] === '/') { i++; } // swallow the / after ** so **/ matches zero directories too
        } else if (c === '*') {
            pattern += '[^/]*';
        } else if (c === '?') {
            pattern += '[^/]';
        } else {
            pattern += escapeGlobChar(c);
        }
    }
    return new RegExp(`^${pattern}$`, 'i');
}

/** The `files.associations` entries that map to the "asp" language, each compiled once per scan rather than once per file. A pattern containing a path separator matches against the file's path relative to the workspace folder; a bare pattern (the common case — `"*.html"`) matches against the file name only. */
function getAspAssociationRules(): AssociationRule[] {
    const associations = otherSetting<Record<string, string>>('files', 'associations') ?? {};
    const rules: AssociationRule[] = [];
    for (const [pattern, languageId] of Object.entries(associations)) {
        if (languageId !== 'asp') { continue; }
        const normalised = pattern.replace(/\\/g, '/');
        rules.push({ matcher: globToRegExp(normalised), matchesFullPath: normalised.includes('/') });
    }
    return rules;
}

export function isAspFile(fullPath: string, relPath: string, extensions: string[], rules: AssociationRule[]): boolean {
    const lower = fullPath.toLowerCase();
    if (extensions.some(ext => lower.endsWith(ext))) { return true; }
    if (rules.length === 0) { return false; }

    const fileName = path.basename(fullPath);
    const relForward = relPath.replace(/\\/g, '/');
    return rules.some(r => r.matcher.test(r.matchesFullPath ? relForward : fileName));
}

/** True for an entry the walk never descends into or lists: node_modules, or a dotfile or dotfolder. */
const skipped = (name: string) => name.startsWith('.') || name === 'node_modules';

export function findAspFilesInFolder(dir: string, root: string, extensions: string[], rules: AssociationRule[]): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return results; }

    for (const entry of entries) {
        if (skipped(entry.name)) { continue; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findAspFilesInFolder(fullPath, root, extensions, rules));
        } else if (entry.isFile() && isAspFile(fullPath, path.relative(root, fullPath), extensions, rules)) {
            results.push(fullPath);
        }
    }
    return results;
}

/** findAspFilesInFolder without holding up the extension host: a large site on a network share takes seconds to walk. */
async function findAspFilesInFolderAsync(dir: string, root: string, extensions: string[], rules: AssociationRule[]): Promise<string[]> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return []; }

    const results: string[] = [];
    for (const entry of entries) {
        if (skipped(entry.name)) { continue; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...await findAspFilesInFolderAsync(fullPath, root, extensions, rules));
        } else if (entry.isFile() && isAspFile(fullPath, path.relative(root, fullPath), extensions, rules)) {
            results.push(fullPath);
        }
    }
    return results;
}

/** True for a path the walk would never reach: inside node_modules or a dotfolder. */
function isSkippedPath(relPath: string): boolean {
    return relPath.split(/[\\/]/).some(skipped);
}

// ─────────────────────────────────────────────────────────────────────────────
// The index
// ─────────────────────────────────────────────────────────────────────────────

/** What changed, as full paths. A changed file's text is different; a created or deleted one came or went. */
export interface AspFilesChange {
    created: string[];
    changed: string[];
    deleted: string[];
}

interface FileIndex {
    files:      Set<string>;
    extensions: string[];
    rules:      AssociationRule[];
}

let _index: FileIndex | undefined;
/** The walk in progress, when one is. */
let _walking: Promise<FileIndex> | undefined;
/** Bumped whenever the index is dropped, so a walk that finishes after it does not come back. */
let _generation = 0;
const _listeners = new Set<(change: AspFilesChange) => void>();
const _indexDisposables: vscode.Disposable[] = [];

function folderOf(fsPath: string): string | undefined {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))?.uri.fsPath;
}

function notify(change: Partial<AspFilesChange>): void {
    const full = { created: change.created ?? [], changed: change.changed ?? [], deleted: change.deleted ?? [] };
    if (full.created.length + full.changed.length + full.deleted.length === 0) { return; }
    for (const listener of _listeners) { listener(full); }
}

/** Forgets the list (folders or associations changed); everything that kept a file's data starts again. */
function dropIndex(): void {
    _index = undefined;
    _walking = undefined;
    _generation++;
    for (const listener of _listeners) { listener({ created: [], changed: [], deleted: [] }); }
}

function newIndex(files: Set<string>, extensions: string[], rules: AssociationRule[]): FileIndex {
    watchWorkspace();
    return { files, extensions, rules };
}

/**
 * Every ASP file in the workspace folders, walking them now if nothing has
 * yet. Prefer aspFiles(), which walks without blocking; this is for the
 * few callers that must answer at once (a file rename's include updates).
 */
export function getWorkspaceAspFiles(): string[] {
    if (!_index) {
        const extensions = getAspFileExtensions();
        const rules      = getAspAssociationRules();
        const files      = new Set<string>();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const root = folder.uri.fsPath;
            for (const file of findAspFilesInFolder(root, root, extensions, rules)) { files.add(file); }
        }
        _index = newIndex(files, extensions, rules);
    }
    return [..._index.files];
}

/** Every ASP file in the workspace folders, walked once without blocking the extension host. */
export async function aspFiles(): Promise<string[]> {
    if (_index) { return [..._index.files]; }
    if (!_walking) {
        const generation = _generation;
        _walking = (async () => {
            const extensions = getAspFileExtensions();
            const rules      = getAspAssociationRules();
            const files      = new Set<string>();
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                const root = folder.uri.fsPath;
                for (const file of await findAspFilesInFolderAsync(root, root, extensions, rules)) { files.add(file); }
            }
            // A sync walk may have finished first, and the watcher has kept it since.
            if (generation === _generation) { _index ??= newIndex(files, extensions, rules); }
            return _index ?? newIndex(files, extensions, rules);
        })();
    }
    return [...(await _walking).files];
}

/** True once the folders have been walked. */
export function isAspIndexReady(): boolean {
    return _index !== undefined;
}

/** Calls `listener` with each change to the ASP files. A change with no files means "everything may have changed". */
export function onAspFilesChange(listener: (change: AspFilesChange) => void): vscode.Disposable {
    _listeners.add(listener);
    return { dispose: () => { _listeners.delete(listener); } };
}

function watchWorkspace(): void {
    if (_indexDisposables.length > 0) { return; }

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    _indexDisposables.push(
        watcher,
        watcher.onDidCreate(uri => { void fileCreated(uri.fsPath); }),
        watcher.onDidDelete(uri => fileDeleted(uri.fsPath)),
        watcher.onDidChange(uri => fileChanged(uri.fsPath)),
        vscode.workspace.onDidChangeWorkspaceFolders(dropIndex),
        onSettingsChange(['files.associations'], dropIndex),
    );
}

function fileChanged(fsPath: string): void {
    if (_index?.files.has(fsPath)) { notify({ changed: [fsPath] }); }
}

async function fileCreated(fsPath: string): Promise<void> {
    const index = _index;
    const root  = folderOf(fsPath);
    if (!index || !root || isSkippedPath(path.relative(root, fsPath))) { return; }

    // An ASP file by its name needs no look at the disk, and most files a
    // build or a checkout writes are neither ASP files nor folders.
    if (isAspFile(fsPath, path.relative(root, fsPath), index.extensions, index.rules)) {
        if (!index.files.has(fsPath)) { index.files.add(fsPath); notify({ created: [fsPath] }); }
        return;
    }
    if (path.extname(fsPath) !== '') { return; }

    // Perhaps a folder, arriving whole (a checkout, a copy) with files already in it.
    let isDirectory: boolean;
    try { isDirectory = (await fs.promises.stat(fsPath)).isDirectory(); } catch { return; }
    if (!isDirectory || _index !== index) { return; }

    const created = (await findAspFilesInFolderAsync(fsPath, root, index.extensions, index.rules))
        .filter(file => !index.files.has(file));
    if (_index !== index) { return; }
    for (const file of created) { index.files.add(file); }
    notify({ created });
}

function fileDeleted(fsPath: string): void {
    const index = _index;
    if (!index) { return; }
    if (index.files.delete(fsPath)) { notify({ deleted: [fsPath] }); return; }

    // Not a file the index knows, so perhaps a folder: its files went with it.
    const prefix = fsPath.endsWith(path.sep) ? fsPath : fsPath + path.sep;
    const deleted = [...index.files].filter(file => file.startsWith(prefix));
    for (const file of deleted) { index.files.delete(file); }
    notify({ deleted });
}

/**
 * Settles once the file events already delivered have been handled — a
 * created folder is walked without blocking. For tests.
 */
export function aspIndexSettled(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 20));
}

/** Stops watching the workspace and forgets the list. Called from deactivate. */
export function disposeWorkspaceIndex(): void {
    for (const disposable of _indexDisposables) { disposable.dispose(); }
    _indexDisposables.length = 0;
    dropIndex();
}
