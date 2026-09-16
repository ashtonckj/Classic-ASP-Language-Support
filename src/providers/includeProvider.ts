import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractSymbols, FileSymbols } from '../utils/symbolParser';


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
    const resolved:    string[] = [];
    const docDir      = path.dirname(documentPath);
    const virtualRoot = getVirtualRoot(documentPath);
    const pattern     = /<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']+)["']\s*-->/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(documentText)) !== null) {
        const includeType = match[1].toLowerCase();
        const includePath = match[2];

        const fullPath = includeType === 'virtual'
            ? path.join(virtualRoot, includePath.replace(/^\//, ''))
            : path.resolve(docDir, includePath);

        if (fs.existsSync(fullPath)) {
            resolved.push(fullPath);
        } else if (includeType === 'virtual') {
            notifyVirtualRootUnresolved(includePath);
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

// Recursively resolves all #include paths starting from a document.
// `visited` prevents infinite loops when files include each other circularly.
export function resolveIncludePaths(documentText: string, documentPath: string, visited: Set<string> = new Set()): string[] {
    const resolved: string[] = [];
    const normalised = documentPath.toLowerCase();

    if (visited.has(normalised)) return resolved;
    visited.add(normalised);

    for (const incPath of resolveDirectIncludes(documentText, documentPath)) {
        if (visited.has(incPath.toLowerCase())) continue;
        resolved.push(incPath);

        // Read from the open buffer when available so a nested #include added to an
        // as-yet-unsaved .inc is still discovered.
        const incText = readIncludeText(incPath);
        if (incText !== null) {
            resolved.push(...resolveIncludePaths(incText, incPath, visited));
        }
    }

    return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default (implicit) includes
// aspLanguageSupport.defaultIncludes lists files that many real apps only pull
// in through a shared bootstrap/layout page — never through the module being
// edited itself — so its symbols would otherwise be invisible to IntelliSense,
// hover, Go to Definition, and Peek Definition. Resolved the same way as
// #include virtual="..." (relative to virtualRoot, or the workspace root).
// ─────────────────────────────────────────────────────────────────────────────

export function getDefaultIncludePaths(documentPath: string): string[] {
    const config    = vscode.workspace.getConfiguration('aspLanguageSupport');
    const configured = config.get<string[]>('defaultIncludes', []);
    if (configured.length === 0) return [];

    const root = getVirtualRoot(documentPath);
    const resolved: string[] = [];

    for (const entry of configured) {
        const fullPath = path.isAbsolute(entry)
            ? entry
            : path.join(root, entry.replace(/^[/\\]/, ''));
        if (fs.existsSync(fullPath)) { resolved.push(fullPath); }
    }

    return resolved;
}

// Everything resolveIncludePaths finds via the document's own #include chain,
// PLUS every configured default include (and, recursively, whatever those
// files themselves #include) that the chain didn't already reach.
export function resolveEffectiveIncludePaths(documentText: string, documentPath: string): string[] {
    const visited  = new Set<string>();
    const resolved = resolveIncludePaths(documentText, documentPath, visited);

    for (const defaultPath of getDefaultIncludePaths(documentPath)) {
        if (visited.has(defaultPath.toLowerCase())) continue;
        resolved.push(defaultPath);

        const text = readIncludeText(defaultPath);
        if (text !== null) {
            resolved.push(...resolveIncludePaths(text, defaultPath, visited));
        }
    }

    return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol collection
// Merges symbols from the current document and all included files (all depths).
// Results are cached by (filePath + documentVersion) and invalidated whenever
// the document changes, avoiding repeated synchronous fs.readFileSync calls
// on every keystroke across all providers.
// ─────────────────────────────────────────────────────────────────────────────

interface IncludeStamp { path: string; token: string; }

interface SymbolCache {
    version:          number;
    symbols:          FileSymbols;
    includeStamps:    IncludeStamp[];
    defaultIncludesKey: string;
}

const _symbolCache = new Map<string, SymbolCache>();

/**
 * A cache-invalidation token for an include. If the file is OPEN in an editor we
 * use its in-memory buffer version, so unsaved edits refresh the including
 * document's symbols immediately; otherwise we use its on-disk mtime.
 */
function includeToken(fsPath: string): string {
    const open = openDocumentFor(fsPath);
    if (open) { return `v${open.version}`; }
    try { return `m${fs.statSync(fsPath).mtimeMs}`; } catch { return 'missing'; }
}

/** True only if every recorded include still has the same change token. */
function includeStampsUnchanged(stamps: IncludeStamp[]): boolean {
    for (const s of stamps) {
        if (includeToken(s.path) !== s.token) { return false; }
    }
    return true;
}

export function collectAllSymbols(document: vscode.TextDocument): FileSymbols {
    const docPath    = document.uri.fsPath;
    const docVersion = document.version;
    const defaultIncludesKey = JSON.stringify(
        vscode.workspace.getConfiguration('aspLanguageSupport').get<string[]>('defaultIncludes', []),
    );

    // A cache hit requires the document version, every included file's token
    // (open-buffer version, or disk mtime when not open), AND the
    // defaultIncludes setting to all be unchanged — otherwise editing a .inc
    // (even unsaved), or editing the setting itself, would leave the including
    // document's merged symbols stale.
    const cached = _symbolCache.get(docPath);
    if (
        cached
        && cached.version === docVersion
        && cached.defaultIncludesKey === defaultIncludesKey
        && includeStampsUnchanged(cached.includeStamps)
    ) {
        return cached.symbols;
    }

    const fullText = document.getText();
    const combined = extractSymbols(fullText, docPath);
    const includeStamps: IncludeStamp[] = [];

    for (const incPath of resolveEffectiveIncludePaths(fullText, docPath)) {
        // Stamp first so a currently-unreadable include still invalidates once it
        // appears or changes.
        includeStamps.push({ path: incPath, token: includeToken(incPath) });
        const incText = readIncludeText(incPath);
        if (incText === null) { continue; }

        const incSymbols = extractSymbols(incText, incPath);
        combined.variables    .push(...incSymbols.variables);
        combined.constants    .push(...incSymbols.constants);
        combined.functions    .push(...incSymbols.functions);
        combined.comVariables .push(...incSymbols.comVariables);
        combined.classes      .push(...incSymbols.classes);
    }

    _symbolCache.set(docPath, { version: docVersion, symbols: combined, includeStamps, defaultIncludesKey });

    // Evict stale entries for files no longer open to avoid unbounded growth
    const openPaths = new Set(vscode.workspace.textDocuments.map(d => d.uri.fsPath));
    for (const key of _symbolCache.keys()) {
        if (!openPaths.has(key)) { _symbolCache.delete(key); }
    }

    return combined;
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

        // Use the same resolution logic as resolveIncludePaths so completions
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (also used by linkProvider.ts and aspHoverProvider.ts)
// These are now defined in ../utils/htmlLinkUtils.ts and re-exported here so
// that any existing import of these names from includeProvider continues to work.
// ─────────────────────────────────────────────────────────────────────────────
export { FILE_LINK_ATTRIBUTES, isExternalPath, isCursorInHtmlFileLinkAttribute } from '../utils/htmlLinkUtils';
// Re-export AspDefinitionProvider from its new dedicated file.
// Any existing import of AspDefinitionProvider from includeProvider continues to work.
export { AspDefinitionProvider } from './aspDefinitionProvider';

// The symbol parser now lives in ../utils/symbolParser (no vscode import, so a
// worker thread can use it too). Re-exported here so existing imports of
// extractSymbols / FileSymbols from this module keep working.
export { extractSymbols, type FileSymbols } from '../utils/symbolParser';
