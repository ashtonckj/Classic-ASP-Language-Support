import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { FileSymbols } from '../vbscript/symbols';
import type { ScopeRequest } from '../vbscript/pageChecks';
import { includeRoot, resolveIncludePathsIn } from '../core/includeDirectives';
import { defaultIncludesSetting, onSettingsChange, virtualRootSetting } from '../platform/settings';
import { loadIncludeTree } from '../workers/analysisClient';
import { pathKey, withoutBom } from '../core/paths';
import { openBuffers, openDocument } from '../platform/documentState';
import { pathCompletions } from '../platform/pathCompletion';
import { isListedAspFile, onAspFilesChange } from '../platform/workspaceIndex';


// ─────────────────────────────────────────────────────────────────────────────
// Virtual root resolution
// Returns the base directory to use when resolving virtual="..." includes.
//
// Priority:
//   1. classicAsp.virtualRoot setting (explicit user override)
//   2. The root of the workspace folder holding the document (the first folder
//      for a document outside them all)
//   3. Directory of the current document (last resort fallback)
// ─────────────────────────────────────────────────────────────────────────────

export function getVirtualRoot(documentPath: string): string {
    return includeRoot(configuredVirtualRoot(documentPath), documentPath);
}

/**
 * The virtual root from steps 1 and 2 only — undefined when neither the setting
 * nor an open folder says where the site starts, and the document's own folder
 * is just a guess.
 */
export function configuredVirtualRoot(documentPath?: string): string | undefined {
    const userSetting = virtualRootSetting();

    if (userSetting) {
        // Expand a leading ~/ on macOS/Linux for convenience
        const expanded = userSetting.startsWith('~/')
            ? path.join(process.env.HOME ?? userSetting, userSetting.slice(2))
            : userSetting;
        return expanded;
    }

    const folder = documentPath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(documentPath)) : undefined;
    return (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
}

/**
 * Returns an include file's current content, preferring the OPEN editor buffer so
 * unsaved edits to a .inc are reflected in the including .asp immediately (the way
 * other language servers resolve dependencies — the editor models what the code
 * *currently says*, even though the ASP engine reads the saved file at runtime).
 * Falls back to disk for includes that aren't open. Returns null if unreadable.
 */
export function readIncludeText(fsPath: string): string | null {
    const open = openDocument(fsPath);
    if (open) { return open.getText(); }
    try { return withoutBom(fs.readFileSync(fsPath, 'utf8')); } catch { return null; }
}

/**
 * What the VBScript worker needs to read `document` with its includes, as the
 * checks and the include symbols both do. The worker reads files from disk; an
 * include open with unsaved changes counts as the editor shows it.
 */
export function scopeRequest(document: vscode.TextDocument): ScopeRequest {
    const docPath = document.uri.fsPath;
    return {
        text: document.getText(),
        docPath,
        configuredRoot: configuredVirtualRoot(docPath),
        defaultIncludes: defaultIncludeCandidates(getVirtualRoot(docPath)),
        openFiles: openBuffers(document).texts,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol collection
//
// The active document is always parsed synchronously from its current editor
// buffer. Include files are loaded and parsed by the VBScript worker thread
// (the same reading of the include tree its checks use) and cached here per
// file, so editing the active document never forces a synchronous walk of the
// include tree on the extension-host thread.
// ─────────────────────────────────────────────────────────────────────────────

interface IncludeSymbolCacheEntry {
    symbols: FileSymbols;
    children: string[];
    // Set when this entry was parsed from an unsaved editor buffer rather than
    // from disk, so a later edit to that buffer can be detected as stale.
    bufferVersion?: number;
}

interface PendingIncludeLoad {
    generation: number;
    promise: Promise<void>;
}

const _includeSymbolCache = new Map<string, IncludeSymbolCacheEntry>();
// Bumped on every write to _includeSymbolCache. collectIncludeSymbols memoises its
// result per document version, and a document's version does NOT change when a
// worker finishes loading its includes — so the memo keys on this as well, or
// the first result computed before the includes arrived would stick.
let _includeSymbolEpoch = 0;
const _includeLoadPromises = new Map<string, PendingIncludeLoad>();
let _includeCacheGeneration = 0;

function mergeSymbols(target: FileSymbols, source: FileSymbols): void {
    target.variables.push(...source.variables);
    target.constants.push(...source.constants);
    target.functions.push(...source.functions);
    target.comVariables.push(...source.comVariables);
    target.classes.push(...source.classes);
}

/**
 * classicAsp.defaultIncludes lists files that many real apps only pull
 * in through a shared bootstrap/layout page — never through the module being
 * edited itself — so their symbols would otherwise be invisible to IntelliSense,
 * hover, Go to Definition, and Peek Definition. Resolved the same way as
 * #include virtual="..." (relative to virtualRoot, or the workspace root).
 *
 * Existence is not checked here: the worker finds out when it tries to read,
 * which keeps the completion hot path free of synchronous disk access.
 */
export function defaultIncludeCandidates(virtualRoot: string): string[] {
    const configured = defaultIncludesSetting();

    return configured.map(entry => path.isAbsolute(entry)
        ? entry
        : path.join(virtualRoot, entry.replace(/^[/\\]/, '')));
}

function includeRoots(document: vscode.TextDocument): string[] {
    const virtualRoot = getVirtualRoot(document.uri.fsPath);
    // Path-only on purpose: the worker finds out which of these are readable,
    // so the completion hot path never does existsSync/statSync on an include.
    const roots = [
        ...resolveIncludePathsIn(document.getText(), document.uri.fsPath, virtualRoot),
        ...defaultIncludeCandidates(virtualRoot),
    ];

    const seen = new Set<string>();
    return roots.filter(root => {
        const key = pathKey(root);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

function cachedTreeReady(fsPath: string, visited: Set<string>): boolean {
    const key = pathKey(fsPath);
    if (visited.has(key)) { return true; }
    visited.add(key);

    const cached = _includeSymbolCache.get(key);
    if (!cached) { return false; }

    // An entry read from disk is stale once the include has unsaved edits. One
    // read from an unsaved buffer is stale once that exact buffer is gone: a
    // later keystroke, an undo back to the saved text, a revert, or a close
    // without saving, none of which change the file on disk.
    const open = openDocument(fsPath);
    const stale = cached.bufferVersion === undefined
        ? open?.isDirty
        : cached.bufferVersion !== open?.version;
    if (stale) { return false; }

    return cached.children.every(child => cachedTreeReady(child, visited));
}

export function areIncludeSymbolsReady(document: vscode.TextDocument): boolean {
    if (document.languageId !== 'asp') { return true; }
    const visited = new Set<string>();
    return includeRoots(document).every(root => cachedTreeReady(root, visited));
}

/**
 * Loads the document's include tree on the VBScript worker. Repeated callers share the
 * same in-flight request, and stale results are ignored after cache invalidation.
 */
export function preloadIncludeSymbols(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'asp') { return Promise.resolve(); }

    const roots = includeRoots(document);
    if (roots.length === 0 || areIncludeSymbolsReady(document)) {
        return Promise.resolve();
    }

    const request = scopeRequest(document);
    const generation = _includeCacheGeneration;
    const requestKey = [
        pathKey(request.configuredRoot ?? ''),
        ...roots.map(pathKey).sort(),
    ].join('|');

    const pending = _includeLoadPromises.get(requestKey);
    if (pending?.generation === generation) {
        return pending.promise;
    }

    // Which buffer each unsaved text was read from, to tell when it goes stale.
    const openVersions = openBuffers(document).versions;

    // Include loading is best-effort: the worker never rejects, and a load that
    // failed or was superseded leaves the cache as it was.
    const promise = loadIncludeTree(requestKey, request).then(entries => {
        if (!entries || generation !== _includeCacheGeneration) { return; }
        for (const entry of entries) {
            const key = pathKey(entry.filePath);
            _includeSymbolCache.set(key, {
                symbols: entry.symbols,
                children: entry.children,
                bufferVersion: openVersions.get(key),
            });
            void watchIncludeFolder(entry.filePath);
        }
        _includeSymbolEpoch++;
    });

    _includeLoadPromises.set(requestKey, { generation, promise });
    return promise.finally(() => {
        if (_includeLoadPromises.get(requestKey)?.promise === promise) {
            _includeLoadPromises.delete(requestKey);
        }
    });
}

function appendCachedIncludeSymbols(target: FileSymbols, fsPath: string, visited: Set<string>): void {
    const key = pathKey(fsPath);
    if (visited.has(key)) { return; }
    visited.add(key);

    const cached = _includeSymbolCache.get(key);
    if (!cached) { return; }

    mergeSymbols(target, cached.symbols);
    for (const childPath of cached.children) {
        appendCachedIncludeSymbols(target, childPath, visited);
    }
}

/**
 * The named forms, images, embeds, objects and frames a document's includes
 * write, as their tags, so the page's JavaScript knows `document.myForm` when
 * the form is in an include. Read from the cached include tree, and from each
 * include once until an include changes.
 */
const _namedTagsByFile = new Map<string, string>();
let _namedTagsEpoch = -1;
const NAMED_TAG = /<(?:form|img|embed|object|iframe)\b[^>]*?\bname\s*=[^>]*>/gi;

export function includeNamedElements(document: vscode.TextDocument): string {
    if (document.languageId !== 'asp') { return ''; }
    if (_namedTagsEpoch !== _includeSymbolEpoch) { _namedTagsByFile.clear(); _namedTagsEpoch = _includeSymbolEpoch; }
    const tags: string[] = [];
    const visited = new Set<string>();
    const walk = (fsPath: string) => {
        const key = pathKey(fsPath);
        const cached = _includeSymbolCache.get(key);
        if (visited.has(key) || !cached) { return; }
        visited.add(key);
        let fileTags = _namedTagsByFile.get(key);
        if (fileTags === undefined) {
            fileTags = (readIncludeText(fsPath) ?? '').match(NAMED_TAG)?.join('\n') ?? '';
            _namedTagsByFile.set(key, fileTags);
        }
        if (fileTags) { tags.push(fileTags); }
        cached.children.forEach(walk);
    };
    includeRoots(document).forEach(walk);
    return tags.join('\n');
}

/**
 * A result kept per document version and include epoch (the include symbols
 * change without the document's version changing).
 *
 * Keyed by the document itself, not its URI: a file closed and opened again, or
 * a new Untitled-1 after the last one was closed, starts over at version 1, and
 * a URI key handed it the closed document's symbols. A closed document's entry
 * goes when the document does.
 */
type SymbolMemo = WeakMap<vscode.TextDocument, { version: number; epoch: number; symbols: FileSymbols }>;

/**
 * The symbols a document's includes declare, without its own.
 *
 * For the ASP colouring, which runs on a worker thread and reads the page's own
 * symbols there from the text it is sent. Collecting them here instead meant
 * parsing the whole page on the extension host after every edit.
 *
 * Memoised, so the same object comes back until the
 * document or an include changes — which is how the colouring knows it can reuse
 * its last answer.
 */
const _includeOnlyMemo: SymbolMemo = new WeakMap();

export function collectIncludeSymbols(document: vscode.TextDocument): FileSymbols {
    if (!areIncludeSymbolsReady(document)) {
        void preloadIncludeSymbols(document);
    }

    const memo = _includeOnlyMemo.get(document);
    if (memo && memo.version === document.version && memo.epoch === _includeSymbolEpoch) {
        return memo.symbols;
    }

    const symbols: FileSymbols = { variables: [], constants: [], functions: [], comVariables: [], classes: [] };
    const visited = new Set<string>();
    for (const includePath of includeRoots(document)) {
        appendCachedIncludeSymbols(symbols, includePath, visited);
    }

    _includeOnlyMemo.set(document, { version: document.version, epoch: _includeSymbolEpoch, symbols });
    return symbols;
}


/**
 * `own`, a page's own symbols (as the VBScript worker read them), followed by
 * what its includes declare: every symbol the page can see.
 */
export function withIncludeSymbols(document: vscode.TextDocument, own: FileSymbols): FileSymbols {
    const includes = collectIncludeSymbols(document);
    return {
        variables:    [...own.variables,    ...includes.variables],
        constants:    [...own.constants,    ...includes.constants],
        functions:    [...own.functions,    ...includes.functions],
        comVariables: [...own.comVariables, ...includes.comVariables],
        classes:      [...own.classes,      ...includes.classes],
    };
}

/**
 * Forgets one file's include symbols, because it changed on disk.
 *
 * Only that file: saving a page used to throw away every include of every open
 * page, and each of those then went back to the worker to be read and parsed
 * again. A load already under way may have read the old text, so its results
 * are ignored and whatever it covered is loaded again when next asked for.
 */
function forgetIncludeFile(fsPath: string): void {
    const key = pathKey(fsPath);
    if (!_includeSymbolCache.has(key) && _includeLoadPromises.size === 0) { return; }
    _includeCacheGeneration++;
    _includeSymbolEpoch++;
    _includeSymbolCache.delete(key);
    pruneIncludeFolderWatchers();
}

function forgetAllIncludes(): void {
    _includeCacheGeneration++;
    _includeSymbolEpoch++;
    _includeSymbolCache.clear();
    pruneIncludeFolderWatchers();
}

/**
 * Forgets an include's symbols when it changes on disk — saved in the editor,
 * or changed by a checkout, another editor, a deploy script — and every
 * include's when what an include path resolves to, or which files every page
 * includes, changes. Registered from registerAspFeatures.
 */
export function watchIncludeChanges(): vscode.Disposable[] {
    return [
        onAspFilesChange(change => {
            const files = [...change.created, ...change.changed, ...change.deleted];
            if (files.length === 0) { forgetAllIncludes(); return; }
            for (const file of files) { forgetIncludeFile(file); }
        }),
        onSettingsChange(['classicAsp.virtualRoot', 'classicAsp.defaultIncludes'], forgetAllIncludes),
        vscode.workspace.onDidChangeWorkspaceFolders(forgetAllIncludes),
    ];
}

// The workspace index reports changes to the ASP files it lists. An include it
// does not list — outside the workspace, or not named like an ASP file — has its
// folder watched instead, without recursing into it, for as long as an include
// in that folder is cached.
const _includeFolderWatchers = new Map<string, vscode.FileSystemWatcher>();

async function watchIncludeFolder(filePath: string): Promise<void> {
    if (await isListedAspFile(filePath) || !_includeSymbolCache.has(pathKey(filePath))) { return; }
    const folder = path.dirname(filePath);
    const key = pathKey(folder);
    if (_includeFolderWatchers.has(key)) { return; }

    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(folder), '*'),
    );
    const forget = (uri: vscode.Uri) => forgetIncludeFile(uri.fsPath);
    watcher.onDidChange(forget);
    watcher.onDidCreate(forget);
    watcher.onDidDelete(forget);
    _includeFolderWatchers.set(key, watcher);
}

/** Stops watching the folders no cached include is in any more. */
function pruneIncludeFolderWatchers(): void {
    if (_includeFolderWatchers.size === 0) { return; }
    const needed = new Set([..._includeSymbolCache.keys()].map(key => path.dirname(key)));
    for (const [folder, watcher] of _includeFolderWatchers) {
        if (!needed.has(folder)) { watcher.dispose(); _includeFolderWatchers.delete(folder); }
    }
}

/** Stops watching include folders. Called from deactivate. */
export function disposeIncludeWatchers(): void {
    for (const watcher of _includeFolderWatchers.values()) { watcher.dispose(); }
    _includeFolderWatchers.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// IncludePathCompletionProvider
// Suggests files and folders inside the quotes of #include directives.
// ─────────────────────────────────────────────────────────────────────────────

export class IncludePathCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);
        const includeMatch = textBefore.match(/<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']*)$/i);
        if (!includeMatch) return new vscode.CompletionList([], false);

        const includeType = includeMatch[1].toLowerCase();
        const typedSoFar  = includeMatch[2];
        const docDir      = path.dirname(document.uri.fsPath);

        // Browse from the root each directive kind resolves against
        const baseDir = includeType === 'virtual'
            ? getVirtualRoot(document.uri.fsPath)
            : docDir;

        return pathCompletions(position, typedSoFar, baseDir, 'Include file', token);
    }
}
