import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import { extractSymbols, type FileSymbols } from '../utils/symbolParser';
import { resolveIncludePathsIn } from '../utils/includeDirectives';

interface IncludeWorkerRequest {
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

parentPort?.on('message', async ({ roots, virtualRoot, openFiles }: IncludeWorkerRequest) => {
    const results: IncludeWorkerEntry[] = [];
    const visited = new Set<string>();

    for (const root of roots) {
        await loadTree(root, virtualRoot, visited, results, openFiles ?? {});
    }

    parentPort?.postMessage(results);
});
