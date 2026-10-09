/**
 * scriptScope.ts
 *
 * One page's script scope: the page and every file it includes, as IIS sees
 * them. IIS pastes each `#include` into the page before compiling it, so a
 * page and its includes are one program with one set of page-wide names.
 *
 * Each file is parsed on its own and keeps its own offsets. `chunks` records
 * the order IIS reads the text in: the page up to its first include, that
 * include (with its own includes inside it), the page up to the next include,
 * and so on. Pasting the text together instead would need a map from every
 * offset back to its file, and a fresh parse of every include each time the
 * page changes.
 *
 * Imports no vscode APIs: the caller says how to read and resolve a file, so
 * the editor (open buffers first), a worker thread and the tests share it.
 */

import { parseIncludeDirectives, type IncludeDirective } from '../core/includeDirectives';
import { parsePage, type ParsedPage } from './symbols';
import { pathKey } from '../core/paths';

export interface ScopeFile {
    path: string;
    text: string;
    page: ParsedPage;
    includes: ScopeInclude[];
}

export interface ScopeInclude {
    directive: IncludeDirective;
    /** Where the directive ends, after its `-->`. */
    end: number;
    /** The resolved path. */
    path: string;
    /** The file it names, or null when that could not be read. */
    file: ScopeFile | null;
}

/** A stretch of one file's text, in the order IIS reads the program. */
export interface Chunk {
    file: ScopeFile;
    start: number;
    end: number;
}

/** Something about the includes IIS would complain of. */
export interface ScopeProblem {
    kind: 'missing' | 'loop' | 'twice';
    file: ScopeFile;
    start: number;
    end: number;
    message: string;
}

export interface ScriptScope {
    root: ScopeFile;
    /** Every file once, the page first, then in the order they are first included. */
    files: ScopeFile[];
    chunks: Chunk[];
    problems: ScopeProblem[];
}

export interface ScopeHost {
    /** A file's text, or null when it cannot be read. */
    read(path: string): string | null;
    /** The absolute path a directive in `fromPath` names. */
    resolve(directive: IncludeDirective, fromPath: string): string;
    /** How to parse a file; lets a caller reuse a cached parse. */
    parse?(path: string, text: string): ParsedPage;
    /**
     * Files to count as included at the top of the page, for a site whose
     * pages get them from a shared layout page instead (the defaultIncludes
     * setting). One that cannot be read is left out.
     */
    defaultIncludes?(rootPath: string): string[];
}

export function buildScriptScope(rootPath: string, rootText: string, host: ScopeHost): ScriptScope {
    const loaded = new Map<string, ScopeFile | null>();
    const files: ScopeFile[] = [];
    const parse = host.parse ?? ((_path: string, text: string) => parsePage(text));

    const load = (path: string, text: string | null): ScopeFile | null => {
        const key = pathKey(path);
        if (loaded.has(key)) { return loaded.get(key)!; }
        if (text === null) { loaded.set(key, null); return null; }

        const file: ScopeFile = { path, text, page: parse(path, text), includes: [] };
        loaded.set(key, file);
        files.push(file);

        for (const directive of parseIncludeDirectives(text)) {
            const close = text.indexOf('-->', directive.index);
            const target = host.resolve(directive, path);
            file.includes.push({
                directive,
                end: close === -1 ? text.length : close + 3,
                path: target,
                file: load(target, loaded.has(pathKey(target)) ? null : host.read(target)),
            });
        }
        return file;
    };

    const root = load(rootPath, rootText)!;
    const defaults: ScopeFile[] = [];
    for (const path of host.defaultIncludes?.(rootPath) ?? []) {
        const file = load(path, loaded.has(pathKey(path)) ? null : host.read(path));
        if (file && file !== root && !defaults.includes(file)) { defaults.push(file); }
    }
    const chunks: Chunk[] = [];
    const problems: ScopeProblem[] = [];
    const expanded = new Set<ScopeFile>();

    const linearize = (file: ScopeFile, stack: ScopeFile[]): void => {
        expanded.add(file);
        let pos = 0;
        for (const inc of file.includes) {
            if (inc.directive.index > pos) { chunks.push({ file, start: pos, end: inc.directive.index }); }
            pos = inc.end;

            const at = { file, start: inc.directive.index, end: inc.end };
            if (!inc.file) {
                problems.push({ ...at, kind: 'missing', message: `Include file not found: ${inc.path}` });
            } else if (stack.includes(inc.file) || inc.file === file) {
                problems.push({ ...at, kind: 'loop', message: `The include file '${inc.directive.raw}' includes itself` });
            } else if (expanded.has(inc.file)) {
                // IIS pastes it in again, so everything it declares is declared twice.
                // A default include is only counted as included, so including it for real is fine.
                if (!defaults.includes(inc.file)) {
                    problems.push({ ...at, kind: 'twice', message: `'${inc.directive.raw}' is already included on this page` });
                }
            } else {
                linearize(inc.file, [...stack, file]);
            }
        }
        if (pos < file.text.length) { chunks.push({ file, start: pos, end: file.text.length }); }
    };
    for (const file of defaults) { if (!expanded.has(file)) { linearize(file, []); } }
    linearize(root, []);

    return { root, files, chunks, problems };
}

/**
 * Where an offset of one file falls in the order IIS reads the program: a
 * number that sorts statements of different files the way IIS meets them.
 */
export function orderKey(scope: ScriptScope, file: ScopeFile, offset: number): number {
    for (let i = 0; i < scope.chunks.length; i++) {
        const c = scope.chunks[i];
        if (c.file === file && offset >= c.start && offset < c.end) { return i * 2 ** 32 + offset; }
    }
    return Number.MAX_SAFE_INTEGER;
}
