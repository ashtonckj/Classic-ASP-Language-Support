/**
 * includeSymbolWorker.ts
 *
 * The worker thread that reads and parses the include tree of a page: each
 * file's symbols and the includes it names in turn, from disk or, for a file
 * open with unsaved changes, from the text the extension host sends.
 */

import * as fs from 'node:fs/promises';
import { extractSymbols, type FileSymbols } from '../vbscript/symbolParser';
import { resolveIncludePathsIn } from '../core/includeDirectives';
import { serveWorker, type WorkerAnswer } from './serveWorker';

export interface IncludeWorkerRequest {
    id: number;
    roots: string[];
    virtualRoot: string;
    // Unsaved text for any include open in the editor, keyed by lowercased
    // path. This thread has no vscode API, so it cannot see editor buffers by
    // itself — the extension host reads them and sends the text across.
    openFiles: Record<string, string>;
}

export interface IncludeWorkerEntry {
    filePath: string;
    symbols: FileSymbols;
    children: string[];
}

export interface IncludeWorkerResult extends WorkerAnswer {
    /** Every file of the tree, each once, in the order it was reached. */
    entries: IncludeWorkerEntry[];
}

async function loadTree(
    filePath: string,
    virtualRoot: string,
    visited: Set<string>,
    results: IncludeWorkerEntry[],
    openFiles: Record<string, string>,
): Promise<void> {
    const key = filePath.toLowerCase();
    if (visited.has(key)) { return; }
    visited.add(key);

    // Prefer what the editor currently shows over what was last saved, the way
    // every mainstream language server resolves an open dependency.
    const unsaved = openFiles[key];
    let text: string;
    try {
        text = unsaved !== undefined ? unsaved : await fs.readFile(filePath, 'utf8');
    } catch {
        results.push({
            filePath,
            symbols: { variables: [], constants: [], functions: [], comVariables: [], classes: [] },
            children: [],
        });
        return;
    }

    const children = resolveIncludePathsIn(text, filePath, virtualRoot);
    results.push({
        filePath,
        symbols: extractSymbols(text, filePath),
        children,
    });

    for (const child of children) {
        await loadTree(child, virtualRoot, visited, results, openFiles);
    }
}

async function loadIncludeTree({ id, roots, virtualRoot, openFiles }: IncludeWorkerRequest): Promise<IncludeWorkerResult> {
    const entries: IncludeWorkerEntry[] = [];
    const visited = new Set<string>();

    for (const root of roots) {
        await loadTree(root, virtualRoot, visited, entries, openFiles ?? {});
    }

    return { id, entries };
}

// Include symbols are best-effort: a file that trips the parser costs this one
// load, not the worker.
serveWorker<IncludeWorkerRequest, IncludeWorkerResult>(loadIncludeTree, request => ({ id: request.id, entries: [] }));
