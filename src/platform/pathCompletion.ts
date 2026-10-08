/**
 * pathCompletion.ts
 *
 * The files and folders offered while a path is typed inside quotes: an
 * #include's file="…" or virtual="…", and an href, src or action value. Both
 * browse the same way, so they share this.
 *
 * The folder is read without blocking the extension host, as the list is asked
 * for on every keystroke inside the quotes.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The entries of the folder `typed` points into, from `baseDir`, as completion
 * items that replace only the last segment of `typed` (so a folder already
 * typed is never written twice). A leading `/` is read from `baseDir`, the
 * site root, never from the drive root. `fileDetail` is what a file is called
 * in the list: "Include file", "File".
 *
 * The list is always incomplete, so VS Code asks again on the next keystroke,
 * when the folder may have changed.
 */
export async function pathCompletions(
    position: vscode.Position,
    typed: string,
    baseDir: string,
    fileDetail: string,
    token?: vscode.CancellationToken,
): Promise<vscode.CompletionList> {
    const normalised   = typed.replace(/\\/g, '/');
    const lastSlash    = normalised.lastIndexOf('/');
    const typedDirPart = lastSlash >= 0 ? normalised.slice(0, lastSlash + 1) : '';
    const typedSegment = lastSlash >= 0 ? normalised.slice(lastSlash + 1)    : normalised;
    const searchDir    = path.resolve(baseDir, typedDirPart.replace(/^\/+/, '').replace(/\//g, path.sep));

    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(searchDir, { withFileTypes: true });
    } catch {
        return new vscode.CompletionList([], true);
    }
    if (token?.isCancellationRequested) { return new vscode.CompletionList([], true); }

    const range = new vscode.Range(position.translate(0, -typedSegment.length), position);
    const items: vscode.CompletionItem[] = [];

    for (const entry of entries) {
        if (entry.name.startsWith('.')) { continue; }
        const isDir = entry.isDirectory();
        if (!isDir && !entry.isFile()) { continue; }

        const item = new vscode.CompletionItem(
            entry.name,
            isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
        );
        item.insertText = isDir ? entry.name + '/' : entry.name;
        item.filterText = entry.name;
        item.range      = range;
        item.detail     = isDir ? 'Directory' : fileDetail;
        item.sortText   = (isDir ? '0_' : '1_') + entry.name.toLowerCase();
        // Open the next level as soon as a folder is picked.
        if (isDir) { item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' }; }
        items.push(item);
    }

    return new vscode.CompletionList(items, true);
}

/** Every character a path can be typed with, so the list follows the typing. */
export const PATH_TRIGGER_CHARACTERS = [
    '"', "'", '/', '\\', '.',
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '_', '-',
];
