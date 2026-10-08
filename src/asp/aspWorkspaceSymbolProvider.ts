/**
 * aspWorkspaceSymbolProvider.ts
 *
 * Provides workspace-wide symbol search (Ctrl+T) for Classic ASP projects.
 * Searches every ASP file of the workspace index (platform/workspaceIndex) for
 * Functions, Subs, Classes, and Constants matching the user's query string.
 *
 * Results are streamed as VS Code SymbolInformation objects pointing to the
 * exact line where each symbol is declared.
 *
 * Ctrl+T asks again on every keystroke typed into it. Each file's symbols are
 * read once and kept until the watcher says the file changed, so a keystroke
 * costs a filter over names already lower-cased, not a read of the site. The
 * first query reads the files without blocking, and stops between files once a
 * newer keystroke has cancelled it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { symbolsFromTree } from '../vbscript/symbols';
import { aspFiles, onAspFilesChange } from '../platform/workspaceIndex';

interface IndexedSymbol {
    /** The name, lower-cased once rather than on every keystroke. */
    key:    string;
    symbol: vscode.SymbolInformation;
}

const _wsCache = new Map<string, IndexedSymbol[]>();
let _watching: vscode.Disposable | undefined;

/** Starts dropping a file's symbols when the workspace index says it changed. */
function watchFiles(): void {
    _watching ??= onAspFilesChange(change => {
        if (change.created.length + change.changed.length + change.deleted.length === 0) { _wsCache.clear(); return; }
        for (const file of [...change.created, ...change.changed, ...change.deleted]) { _wsCache.delete(file); }
    });
}

function symbolsOfText(filePath: string, text: string): IndexedSymbol[] {
    const raw     = symbolsFromTree(text, filePath);
    const fileUri = vscode.Uri.file(filePath);
    const at      = (line: number) => new vscode.Location(fileUri, new vscode.Position(Math.max(0, line), 0));
    const symbols: vscode.SymbolInformation[] = [
        ...raw.functions.map(fn => new vscode.SymbolInformation(
            fn.name,
            fn.kind === 'Function' ? vscode.SymbolKind.Function : vscode.SymbolKind.Method,
            fn.params ? `(${fn.params})` : '',
            at(fn.line),
        )),
        ...raw.constants.map(c => new vscode.SymbolInformation(c.name, vscode.SymbolKind.Constant, `= ${c.value}`, at(c.line))),
        ...raw.comVariables.map(cv => new vscode.SymbolInformation(cv.name, vscode.SymbolKind.Variable, cv.progId, at(cv.line))),
        ...raw.classes.map(cls => new vscode.SymbolInformation(cls.name, vscode.SymbolKind.Class, '', at(cls.line))),
    ];
    return symbols.map(symbol => ({ key: symbol.name.toLowerCase(), symbol }));
}

async function symbolsOfFile(filePath: string): Promise<IndexedSymbol[]> {
    const cached = _wsCache.get(filePath);
    if (cached) { return cached; }

    let text: string;
    try { text = await fs.promises.readFile(filePath, 'utf8'); }
    catch { return []; }

    const symbols = symbolsOfText(filePath, text);
    _wsCache.set(filePath, symbols);
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

    async provideWorkspaceSymbols(
        query: string,
        token: vscode.CancellationToken
    ): Promise<vscode.SymbolInformation[] | undefined> {

        if ((vscode.workspace.workspaceFolders ?? []).length === 0) { return []; }
        watchFiles();

        const queryLower = query.toLowerCase();
        const results:   IndexedSymbol[] = [];

        for (const filePath of await aspFiles()) {
            if (token.isCancellationRequested) { return undefined; }
            for (const indexed of await symbolsOfFile(filePath)) {
                // Empty query returns everything; otherwise filter by name prefix/substring
                if (!queryLower || indexed.key.includes(queryLower)) {
                    results.push(indexed);
                }
            }
        }

        // Sort: exact matches first, then prefix matches, then substring matches
        if (queryLower) {
            const rank = (key: string) => key === queryLower ? 0 : key.startsWith(queryLower) ? 1 : 2;
            results.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
        }

        return results.map(indexed => indexed.symbol);
    }
}
