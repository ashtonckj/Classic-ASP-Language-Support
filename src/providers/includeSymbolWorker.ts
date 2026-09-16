import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { extractSymbols, type FileSymbols } from '../utils/symbolParser';

interface IncludeWorkerRequest {
    roots: string[];
    virtualRoot: string;
}

export interface IncludeWorkerEntry {
    filePath: string;
    symbols: FileSymbols;
    children: string[];
}

function directIncludes(text: string, documentPath: string, virtualRoot: string): string[] {
    const includes: string[] = [];
    const pattern = /<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']+)["']\s*-->/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        const includeType = match[1].toLowerCase();
        const includePath = match[2];

        includes.push(includeType === 'virtual'
            ? path.join(virtualRoot, includePath.replace(/^\//, ''))
            : path.resolve(path.dirname(documentPath), includePath));
    }

    return includes;
}

async function loadTree(
    filePath: string,
    virtualRoot: string,
    visited: Set<string>,
    results: IncludeWorkerEntry[],
): Promise<void> {
    const key = filePath.toLowerCase();
    if (visited.has(key)) { return; }
    visited.add(key);

    let text: string;
    try {
        text = await fs.readFile(filePath, 'utf8');
    } catch {
        results.push({
            filePath,
            symbols: { variables: [], constants: [], functions: [], comVariables: [], classes: [] },
            children: [],
        });
        return;
    }

    const children = directIncludes(text, filePath, virtualRoot);
    results.push({
        filePath,
        symbols: extractSymbols(text, filePath),
        children,
    });

    for (const child of children) {
        await loadTree(child, virtualRoot, visited, results);
    }
}

parentPort?.on('message', async ({ roots, virtualRoot }: IncludeWorkerRequest) => {
    const results: IncludeWorkerEntry[] = [];
    const visited = new Set<string>();

    for (const root of roots) {
        await loadTree(root, virtualRoot, visited, results);
    }

    parentPort?.postMessage(results);
});
