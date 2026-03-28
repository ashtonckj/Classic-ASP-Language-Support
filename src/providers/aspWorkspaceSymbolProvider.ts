/**
 * aspWorkspaceSymbolProvider.ts
 *
 * Provides workspace-wide symbol search (Ctrl+T) for Classic ASP projects.
 * Searches all .asp and .inc files in the workspace for Functions, Subs,
 * Classes, and Constants matching the user's query string.
 *
 * Results are streamed as VS Code SymbolInformation objects pointing to the
 * exact line where each symbol is declared.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractSymbols } from './includeProvider';

// ─────────────────────────────────────────────────────────────────────────────
// File discovery
// ─────────────────────────────────────────────────────────────────────────────

function findAspFilesInFolder(dir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return results; }

    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findAspFilesInFolder(fullPath));
        } else if (entry.isFile() && /\.(asp|inc)$/i.test(entry.name)) {
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

        const queryLower = query.toLowerCase();
        const results:   vscode.SymbolInformation[] = [];

        for (const folder of folders) {
            const files = findAspFilesInFolder(folder.uri.fsPath);
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