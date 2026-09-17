/**
 * aspWorkspaceSymbolProvider.ts
 *
 * Provides workspace-wide symbol search (Ctrl+T) for Classic ASP projects.
 * Searches every file in the workspace that counts as an ASP file — either by
 * extension (.asp / .inc) or because the user's own `files.associations`
 * maps it to the "asp" language (e.g. a legacy codebase that keeps its
 * Classic ASP code in .html files) — for Functions, Subs, Classes, and
 * Constants matching the user's query string.
 *
 * Results are streamed as VS Code SymbolInformation objects pointing to the
 * exact line where each symbol is declared.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractSymbols } from '../utils/symbolParser';

// ─────────────────────────────────────────────────────────────────────────────
// File discovery
// ─────────────────────────────────────────────────────────────────────────────

/** The extensions this extension's own package.json registers for the "asp" language, read live so a future change to that list needs no update here. Falls back to the current values if the manifest can't be read (e.g. under the unit-test stub). */
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
    const associations = vscode.workspace.getConfiguration('files').get<Record<string, string>>('associations', {});
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

export function findAspFilesInFolder(dir: string, root: string, extensions: string[], rules: AssociationRule[]): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return results; }

    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findAspFilesInFolder(fullPath, root, extensions, rules));
        } else if (entry.isFile() && isAspFile(fullPath, path.relative(root, fullPath), extensions, rules)) {
            results.push(fullPath);
        }
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple in-memory cache — invalidated on any file save so results stay fresh
// without re-scanning on every keystroke.
// ─────────────────────────────────────────────────────────────────────────────

interface CachedFileSymbols {
    mtime:     number;
    symbols:   vscode.SymbolInformation[];
}

const _wsCache = new Map<string, CachedFileSymbols>();

function getSymbolsForFile(filePath: string): vscode.SymbolInformation[] {
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { return []; }

    const cached = _wsCache.get(filePath);
    if (cached && cached.mtime === mtime) { return cached.symbols; }

    let text: string;
    try { text = fs.readFileSync(filePath, 'utf8'); }
    catch { return []; }

    const raw     = extractSymbols(text, filePath);
    const fileUri = vscode.Uri.file(filePath);
    const symbols: vscode.SymbolInformation[] = [];

    for (const fn of raw.functions) {
        const line = Math.max(0, fn.line);
        symbols.push(new vscode.SymbolInformation(
            fn.name,
            fn.kind === 'Function' ? vscode.SymbolKind.Function : vscode.SymbolKind.Method,
            fn.params ? `(${fn.params})` : '',
            new vscode.Location(fileUri, new vscode.Position(line, 0))
        ));
    }

    for (const c of raw.constants) {
        const line = Math.max(0, c.line);
        symbols.push(new vscode.SymbolInformation(
            c.name,
            vscode.SymbolKind.Constant,
            `= ${c.value}`,
            new vscode.Location(fileUri, new vscode.Position(line, 0))
        ));
    }

    for (const cv of raw.comVariables) {
        const line = Math.max(0, cv.line);
        symbols.push(new vscode.SymbolInformation(
            cv.name,
            vscode.SymbolKind.Variable,
            cv.progId,
            new vscode.Location(fileUri, new vscode.Position(line, 0))
        ));
    }

    for (const cls of raw.classes) {
        const line = Math.max(0, cls.line);
        symbols.push(new vscode.SymbolInformation(
            cls.name,
            vscode.SymbolKind.Class,
            '',
            new vscode.Location(fileUri, new vscode.Position(line, 0))
        ));
    }

    _wsCache.set(filePath, { mtime, symbols });
    return symbols;
}

export function clearWorkspaceSymbolCache(filePath?: string): void {
    if (filePath) { _wsCache.delete(filePath); }
    else          { _wsCache.clear(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class AspWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {

    provideWorkspaceSymbols(
        query: string,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SymbolInformation[]> {

        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) { return []; }

        const extensions = getAspFileExtensions();
        const rules       = getAspAssociationRules();
        const queryLower  = query.toLowerCase();
        const results:   vscode.SymbolInformation[] = [];

        for (const folder of folders) {
            const files = findAspFilesInFolder(folder.uri.fsPath, folder.uri.fsPath, extensions, rules);
            for (const filePath of files) {
                for (const sym of getSymbolsForFile(filePath)) {
                    // Empty query returns everything; otherwise filter by name prefix/substring
                    if (!queryLower || sym.name.toLowerCase().includes(queryLower)) {
                        results.push(sym);
                    }
                }
            }
        }

        // Sort: exact matches first, then prefix matches, then substring matches
        if (queryLower) {
            results.sort((a, b) => {
                const al = a.name.toLowerCase();
                const bl = b.name.toLowerCase();
                const aExact  = al === queryLower ? 0 : al.startsWith(queryLower) ? 1 : 2;
                const bExact  = bl === queryLower ? 0 : bl.startsWith(queryLower) ? 1 : 2;
                if (aExact !== bExact) { return aExact - bExact; }
                return al.localeCompare(bl);
            });
        }

        return results;
    }
}