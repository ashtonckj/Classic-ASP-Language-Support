/**
 * pageChecks.ts
 *
 * A page read with its includes from disk, for the VBScript worker thread
 * (workers/vbscriptWorker.ts): everything the checks collection shows about the
 * page's VBScript — Missing Set, and the parser's checks (a name declared twice
 * or never declared, a call with the wrong number of arguments, a local never
 * used, code after an Exit) — and the symbols of each include, for completion.
 * Both read the includes through one ScopeHost, so they agree on which files a
 * page includes.
 *
 * Nothing here imports vscode. The editor sends what only it knows: the text
 * of every file open with unsaved changes, and the settings.
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkPage, globalAsaChecks, objectTagIds, type Check } from './checks';
import { findMissingSet, type MissingSet } from './pageAnalysis';
import { bindAt } from './references';
import { buildScriptScope, type ScopeHost } from './scriptScope';
import { symbolsOfPage, type ParsedPage } from './symbols';
import type { FileSymbols } from './symbolParser';
import { includeRoot, resolveIncludeDirective } from '../core/includeDirectives';
import { pathKey, samePath, withoutBom } from '../core/paths';
import { ASP_OBJECT_NAMES, VBSCRIPT_CONSTANTS, VBSCRIPT_FUNCTIONS } from '../constants/aspKeywords';

/** A page and what decides where its includes are. */
export interface ScopeRequest {
    text:    string;
    docPath: string;
    /** The site root the settings or the open folder give, if any; otherwise each file's own folder. */
    configuredRoot: string | undefined;
    /** The defaultIncludes setting's files for this page, as paths. */
    defaultIncludes: string[];
    /** Unsaved text of the files open in the editor, keyed by lower-cased path. */
    openFiles: Record<string, string>;
}

export interface PageChecks {
    missingSet: MissingSet[];
    checks:     Check[];
}

/** One file a page includes, with its symbols and the files it includes in turn. */
export interface IncludeFile {
    filePath: string;
    symbols:  FileSymbols;
    children: string[];
}

/** The names a page may use without declaring them. */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
    ...ASP_OBJECT_NAMES,
    ...VBSCRIPT_FUNCTIONS.map(name => name.toLowerCase()),
    ...VBSCRIPT_CONSTANTS.map(constant => constant.name.toLowerCase()),
    // VBScript's one built-in class, as in `Set re = New RegExp`.
    'regexp',
    // A statement, though it reads like a call of a Sub.
    'randomize',
]);

/** How the page and its includes are read and resolved: the page's text as sent, an open file's unsaved text, the disk otherwise. */
export function scopeHost(request: ScopeRequest, parse: (fsPath: string, text: string) => ParsedPage): ScopeHost {
    return {
        read: fsPath => {
            if (samePath(fsPath, request.docPath)) { return request.text; }
            const open = request.openFiles[pathKey(fsPath)];
            if (open !== undefined) { return open; }
            try { return withoutBom(fs.readFileSync(fsPath, 'utf8')); } catch { return null; }
        },
        resolve: (directive, fromPath) => resolveIncludeDirective(directive, fromPath, includeRoot(request.configuredRoot, fromPath)),
        parse,
        defaultIncludes: () => request.defaultIncludes,
    };
}

/**
 * Every file the page includes, directly, through another include, or as a
 * default include, each once. One that cannot be read is listed with no
 * symbols, so the editor knows it was looked for.
 */
export function includeFiles(request: ScopeRequest, parse: (fsPath: string, text: string) => ParsedPage): IncludeFile[] {
    const scope = buildScriptScope(request.docPath, request.text, scopeHost(request, parse));
    const loaded = new Map(scope.files.map(file => [pathKey(file.path), file]));
    const found = new Map<string, IncludeFile>();
    for (const target of [...scope.files.flatMap(file => file.includes.map(inc => inc.path)), ...request.defaultIncludes]) {
        const key = pathKey(target);
        if (found.has(key)) { continue; }
        const file = loaded.get(key);
        found.set(key, {
            filePath: target,
            symbols:  file ? symbolsOfPage(file.page, file.path) : { variables: [], constants: [], functions: [], comVariables: [], classes: [] },
            children: file ? file.includes.map(inc => inc.path) : [],
        });
    }
    return [...found.values()];
}

export function checkPageFiles(request: ScopeRequest, parse: (fsPath: string, text: string) => ParsedPage): PageChecks {
    const { text, docPath } = request;
    const host = scopeHost(request, parse);
    const page = parse(docPath, text);
    const bound = bindAt(host, docPath);

    // ── Missing Set, with the object types known from the page and its includes ──
    const comTypes = new Map<string, string>();
    for (const [filePath, file] of bound?.pages ?? [[docPath, page] as const]) {
        for (const variable of symbolsOfPage(file, filePath).comVariables) {
            if (!comTypes.has(variable.name.toLowerCase())) { comTypes.set(variable.name.toLowerCase(), variable.progId); }
        }
    }
    const missingSet = findMissingSet(page, comTypes);

    // ── The parser's checks, on the page bound with its includes ──
    // global.asa has rules of its own.
    const asaChecks = /\.asa$/i.test(docPath) ? globalAsaChecks(text) : [];
    if (!bound) { return { missingSet, checks: asaChecks }; }

    // An <object runat="server"> in global.asa gives every page that object.
    const globalAsa = host.read(path.join(includeRoot(request.configuredRoot, docPath), 'global.asa'));
    const builtins = globalAsa ? new Set([...BUILTIN_NAMES, ...objectTagIds(globalAsa)]) : BUILTIN_NAMES;

    return { missingSet, checks: [...asaChecks, ...checkPage(bound, docPath, builtins)] };
}
