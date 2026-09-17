import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'node:worker_threads';
import { extractSymbols, FileSymbols } from '../utils/symbolParser';
import { parseIncludeDirectives, resolveIncludeDirective, resolveIncludePathsIn } from '../utils/includeDirectives';
// Type only: the worker's own declaration of what it posts back, so the two
// sides cannot drift. `import type` is erased at compile time, so requiring
// this module here never loads the worker script into the extension host.
import type { IncludeWorkerEntry } from './includeSymbolWorker';


// ─────────────────────────────────────────────────────────────────────────────
// Virtual root resolution
// Returns the base directory to use when resolving virtual="..." includes.
//
// Priority:
//   1. aspLanguageSupport.virtualRoot setting (explicit user override)
//   2. First workspace folder root (common case — user opened VS Code at app root)
//   3. Directory of the current document (last resort fallback)
// ─────────────────────────────────────────────────────────────────────────────

export function getVirtualRoot(documentPath: string): string {
    const config      = vscode.workspace.getConfiguration('aspLanguageSupport');
    const userSetting = config.get<string>('virtualRoot', '').trim();

    if (userSetting) {
        // Expand a leading ~/ on macOS/Linux for convenience
        const expanded = userSetting.startsWith('~/')
            ? path.join(process.env.HOME ?? userSetting, userSetting.slice(2))
            : userSetting;
        return expanded;
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? path.dirname(documentPath);
}

// Tracks whether we have already shown the virtual root hint in this session
// so we don't spam the user on every file open.
let _virtualRootWarningShown = false;

/**
 * Shows a one-time information message when a virtual="..." include fails to
 * resolve and no explicit virtualRoot setting has been configured.
 */
function notifyVirtualRootUnresolved(includePath: string): void {
    const config      = vscode.workspace.getConfiguration('aspLanguageSupport');
    const userSetting = config.get<string>('virtualRoot', '').trim();

    // Only notify when the user hasn't already set a root
    if (userSetting || _virtualRootWarningShown) return;
    _virtualRootWarningShown = true;

    vscode.window.showInformationMessage(
        `Classic ASP: could not resolve virtual include "${includePath}". ` +
        `If your virtual root differs from the workspace folder, set ` +
        `"aspLanguageSupport.virtualRoot" in your settings.`,
        'Open Settings'
    ).then(choice => {
        if (choice === 'Open Settings') {
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'aspLanguageSupport.virtualRoot'
            );
        }
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// Include path resolution
// Returns the resolved absolute paths of all #include directives in the text.
// Supports file="..." (relative to current doc) and virtual="..." (virtual root).
// ─────────────────────────────────────────────────────────────────────────────

// Resolves all #include paths from a single file's text — one level only.
export function resolveDirectIncludes(documentText: string, documentPath: string): string[] {
    const virtualRoot = getVirtualRoot(documentPath);
    const resolved: string[] = [];

    for (const directive of parseIncludeDirectives(documentText)) {
        const fullPath = resolveIncludeDirective(directive, documentPath, virtualRoot);

        if (fs.existsSync(fullPath)) {
            resolved.push(fullPath);
        } else if (directive.type === 'virtual') {
            notifyVirtualRootUnresolved(directive.raw);
        }
    }

    return resolved;
}

/** Finds an open editor document for the given fs path (case-insensitive), if any. */
function openDocumentFor(fsPath: string): vscode.TextDocument | undefined {
    const lower = fsPath.toLowerCase();
    return vscode.workspace.textDocuments.find(
        d => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === lower,
    );
}

/**
 * Returns an include file's current content, preferring the OPEN editor buffer so
 * unsaved edits to a .inc are reflected in the including .asp immediately (the way
 * other language servers resolve dependencies — the editor models what the code
 * *currently says*, even though the ASP engine reads the saved file at runtime).
 * Falls back to disk for includes that aren't open. Returns null if unreadable.
 */
export function readIncludeText(fsPath: string): string | null {
    const open = openDocumentFor(fsPath);
    if (open) { return open.getText(); }
    try { return fs.readFileSync(fsPath, 'utf8'); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol collection
//
// The active document is always parsed synchronously from its current editor
// buffer. Include files are loaded and parsed by a worker thread and cached
// independently, so editing the active document never forces a synchronous walk
// of the include tree on the extension-host thread.
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
// Bumped on every write to _includeSymbolCache. collectAllSymbols memoises its
// result per document version, and a document's version does NOT change when a
// worker finishes loading its includes — so the memo keys on this as well, or
// the first result computed before the includes arrived would stick.
let _includeSymbolEpoch = 0;
const _includeLoadPromises = new Map<string, PendingIncludeLoad>();
let _includeCacheGeneration = 0;
const _includeWorkerPath = path.join(__dirname, 'includeSymbolWorker.js');

/**
 * The unsaved text of every open ASP document, keyed by lowercased path.
 *
 * A worker thread cannot call vscode APIs, so left to itself it can only read
 * the file as last saved — which is why an unsaved edit to an include used to
 * be invisible to the page including it. It does not need API access though:
 * the extension host reads the buffers (already in memory, no disk, no parsing)
 * and sends the text along with the paths. Only DIRTY documents are sent —
 * for a saved one the worker would read identical bytes anyway.
 */
function dirtyBuffers(): { texts: Record<string, string>; versions: Map<string, number> } {
    const texts: Record<string, string> = {};
    const versions = new Map<string, number>();

    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'asp' && doc.isDirty && doc.uri.scheme === 'file') {
            const key = doc.uri.fsPath.toLowerCase();
            texts[key] = doc.getText();
            versions.set(key, doc.version);
        }
    }

    return { texts, versions };
}

function mergeSymbols(target: FileSymbols, source: FileSymbols): void {
    target.variables.push(...source.variables);
    target.constants.push(...source.constants);
    target.functions.push(...source.functions);
    target.comVariables.push(...source.comVariables);
    target.classes.push(...source.classes);
}

/**
 * aspLanguageSupport.defaultIncludes lists files that many real apps only pull
 * in through a shared bootstrap/layout page — never through the module being
 * edited itself — so their symbols would otherwise be invisible to IntelliSense,
 * hover, Go to Definition, and Peek Definition. Resolved the same way as
 * #include virtual="..." (relative to virtualRoot, or the workspace root).
 *
 * Existence is not checked here: the worker finds out when it tries to read,
 * which keeps the completion hot path free of synchronous disk access.
 */
function defaultIncludeCandidates(virtualRoot: string): string[] {
    const configured = vscode.workspace
        .getConfiguration('aspLanguageSupport')
        .get<string[]>('defaultIncludes', []);

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
        const key = root.toLowerCase();
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

function cachedTreeReady(fsPath: string, visited: Set<string>): boolean {
    const key = fsPath.toLowerCase();
    if (visited.has(key)) { return true; }
    visited.add(key);

    const cached = _includeSymbolCache.get(key);
    if (!cached) { return false; }

    // An entry parsed before the newest keystroke in a dirty include is stale.
    // A clean document is left alone: its buffer and the file on disk agree.
    const open = openDocumentFor(fsPath);
    if (open?.isDirty && cached.bufferVersion !== open.version) { return false; }

    return cached.children.every(child => cachedTreeReady(child, visited));
}

export function areIncludeSymbolsReady(document: vscode.TextDocument): boolean {
    if (document.languageId !== 'asp') { return true; }
    const visited = new Set<string>();
    return includeRoots(document).every(root => cachedTreeReady(root, visited));
}

/**
 * Starts a worker for the document's include tree. Repeated callers share the
 * same in-flight request, and stale results are ignored after cache invalidation.
 */
export function preloadIncludeSymbols(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'asp') { return Promise.resolve(); }

    const roots = includeRoots(document);
    if (roots.length === 0 || areIncludeSymbolsReady(document)) {
        return Promise.resolve();
    }

    const virtualRoot = getVirtualRoot(document.uri.fsPath);
    const generation = _includeCacheGeneration;
    const requestKey = [
        virtualRoot.toLowerCase(),
        ...roots.map(root => root.toLowerCase()).sort(),
    ].join('|');

    const pending = _includeLoadPromises.get(requestKey);
    if (pending?.generation === generation) {
        return pending.promise;
    }

    const { texts: openFiles, versions: openVersions } = dirtyBuffers();

    const promise = new Promise<void>(resolve => {
        const worker = new Worker(_includeWorkerPath);
        let settled = false;

        const finish = (): void => {
            if (settled) { return; }
            settled = true;
            resolve();
            void worker.terminate();
        };

        worker.once('message', (entries: IncludeWorkerEntry[]) => {
            if (generation === _includeCacheGeneration) {
                for (const entry of entries) {
                    const key = entry.filePath.toLowerCase();
                    _includeSymbolCache.set(key, {
                        symbols: entry.symbols,
                        children: entry.children,
                        bufferVersion: openVersions.get(key),
                    });
                }
                _includeSymbolEpoch++;
            }
            finish();
        });

        // Include loading is best-effort. A missing/unreadable file must never
        // reject a provider request or produce an unhandled promise rejection.
        worker.once('error', finish);
        worker.once('exit', finish);
        worker.postMessage({ roots, virtualRoot, openFiles });
    });

    _includeLoadPromises.set(requestKey, { generation, promise });
    return promise.finally(() => {
        if (_includeLoadPromises.get(requestKey)?.promise === promise) {
            _includeLoadPromises.delete(requestKey);
        }
    });
}

function appendCachedIncludeSymbols(target: FileSymbols, fsPath: string, visited: Set<string>): void {
    const key = fsPath.toLowerCase();
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
 * Every symbol visible to a document: its own, plus its includes'.
 *
 * Memoised per document version. Seven providers call this — semantic tokens on
 * every edit, completion on every keystroke with the suggest widget open, hover
 * on every mouse rest, rename twice in one operation — and each call re-parsed
 * the whole document from scratch, which is ~20 ms on a 12k-line file. Between
 * two keystrokes nothing it reads has changed, so the second parse onwards was
 * pure waste.
 *
 * Callers treat the result as read-only; nothing mutates the returned arrays.
 */
const _combinedSymbolMemo = new Map<string, { version: number; epoch: number; symbols: FileSymbols }>();

export function collectAllSymbols(document: vscode.TextDocument): FileSymbols {
    if (!areIncludeSymbolsReady(document)) {
        void preloadIncludeSymbols(document);
    }

    const memoKey = document.uri.toString();
    const memo = _combinedSymbolMemo.get(memoKey);
    if (memo && memo.version === document.version && memo.epoch === _includeSymbolEpoch) {
        return memo.symbols;
    }

    const combined = extractSymbols(document.getText(), document.uri.fsPath);
    const visited = new Set<string>();

    for (const includePath of includeRoots(document)) {
        appendCachedIncludeSymbols(combined, includePath, visited);
    }

    _combinedSymbolMemo.set(memoKey, {
        version: document.version,
        epoch:   _includeSymbolEpoch,
        symbols: combined,
    });
    evictClosedDocuments();
    return combined;
}

/**
 * Drops memo entries for documents that are no longer open, so a long session
 * that visits hundreds of files does not hold every one of their symbol sets.
 * Only runs when there are more entries than open documents, which is only
 * just after something was closed.
 */
function evictClosedDocuments(): void {
    if (_combinedSymbolMemo.size <= vscode.workspace.textDocuments.length) { return; }

    const open = new Set(vscode.workspace.textDocuments.map(doc => doc.uri.toString()));
    for (const key of _combinedSymbolMemo.keys()) {
        if (!open.has(key)) { _combinedSymbolMemo.delete(key); }
    }
}

/** Invalidates all worker-backed include symbols. In-flight stale results are ignored. */
export function clearIncludeSymbolCache(): void {
    _includeCacheGeneration++;
    _includeSymbolEpoch++;
    _includeSymbolCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// IncludePathCompletionProvider
// Suggests files and folders inside the quotes of #include directives.
// ─────────────────────────────────────────────────────────────────────────────

export class IncludePathCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);
        const includeMatch = textBefore.match(/<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']*)$/i);
        if (!includeMatch) return new vscode.CompletionList([], false);

        const includeType = includeMatch[1].toLowerCase();
        const typedSoFar  = includeMatch[2];
        const docDir      = path.dirname(document.uri.fsPath);

        // Use the same resolution logic as resolveDirectIncludes so completions
        // browse from the correct root for both file="..." and virtual="..."
        const baseDir = includeType === 'virtual'
            ? getVirtualRoot(document.uri.fsPath)
            : docDir;

        // Split typed path into the directory prefix and the current segment
        const normalised   = typedSoFar.replace(/\\/g, '/');
        const lastSlash    = normalised.lastIndexOf('/');
        const typedDirPart = lastSlash >= 0 ? normalised.slice(0, lastSlash + 1) : '';
        const typedSegment = lastSlash >= 0 ? normalised.slice(lastSlash + 1)    : normalised;
        const searchDir    = path.resolve(baseDir, typedDirPart.replace(/\//g, path.sep));

        // Replace only the current segment so the typed directory prefix is never duplicated
        const replaceStart = new vscode.Position(position.line, position.character - typedSegment.length);
        const replaceRange = new vscode.Range(replaceStart, position);

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(searchDir, { withFileTypes: true });
        } catch {
            return new vscode.CompletionList([], true);
        }

        const items: vscode.CompletionItem[] = [];

        for (const entry of entries.filter(e => !e.name.startsWith('.'))) {
            const isDir  = entry.isDirectory();
            const isFile = entry.isFile();
            if (!isDir && !isFile) continue;

            const item = new vscode.CompletionItem(
                entry.name,
                isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
            );
            item.insertText = isDir ? entry.name + '/' : entry.name;
            item.filterText = entry.name;
            item.range      = replaceRange;
            item.detail     = isDir ? 'Directory' : 'Include file';
            item.sortText   = (isDir ? '0_' : '1_') + entry.name.toLowerCase();

            // Re-trigger after folder selection so the next level appears immediately
            if (isDir) item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };

            items.push(item);
        }

        // isIncomplete: true keeps the provider live on every keystroke
        return new vscode.CompletionList(items, true);
    }
}
