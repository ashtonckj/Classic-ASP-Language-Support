/**
 * pageChecks.ts
 *
 * Everything the checks collection shows about a page's VBScript, worked out
 * with its includes read from disk: Missing Set, and the parser's checks (a
 * name declared twice or never declared, a call with the wrong number of
 * arguments, a local never used, code after an Exit).
 *
 * Nothing here imports vscode, so the VBScript worker thread
 * (utils/vbscriptWorker.ts) runs it. The editor sends what only it knows:
 * the text of every file open with unsaved changes, and the settings.
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkPage, objectTagIds, type Check } from './checks';
import { findMissingSet, type MissingSet } from './pageAnalysis';
import { bindAt } from './references';
import type { ScopeHost } from './scriptScope';
import { symbolsOfPage, type ParsedPage } from './symbols';
import { resolveIncludeDirective } from '../utils/includeDirectives';
import { ASP_OBJECT_NAMES, VBSCRIPT_CONSTANTS, VBSCRIPT_FUNCTIONS } from '../constants/aspKeywords';

export interface ChecksRequest {
    text:    string;
    docPath: string;
    /** The site root the settings or the open folder give, if any; otherwise each file's own folder. */
    configuredRoot: string | undefined;
    /** The defaultIncludes setting's files for this page, as paths. */
    defaultIncludes: string[];
    /** Unsaved text of the files open in the editor, keyed by lower-cased path. */
    openFiles: Record<string, string>;
    /** The COM variables the page's includes declare, in include order. */
    includeComVariables: { name: string; progId: string }[];
}

export interface PageChecks {
    missingSet: MissingSet[];
    checks:     Check[];
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

export function checkPageFiles(request: ChecksRequest, parse: (fsPath: string, text: string) => ParsedPage): PageChecks {
    const { text, docPath } = request;
    const rootOf = (fsPath: string) => request.configuredRoot ?? path.dirname(fsPath);
    const read = (fsPath: string): string | null => {
        if (fsPath.toLowerCase() === docPath.toLowerCase()) { return text; }
        const open = request.openFiles[fsPath.toLowerCase()];
        if (open !== undefined) { return open; }
        try { return fs.readFileSync(fsPath, 'utf8'); } catch { return null; }
    };

    // ── Missing Set, with the object types known from the page and its includes ──
    const page = parse(docPath, text);
    const comTypes = new Map<string, string>();
    for (const variable of [...symbolsOfPage(page, docPath).comVariables, ...request.includeComVariables]) {
        if (!comTypes.has(variable.name.toLowerCase())) { comTypes.set(variable.name.toLowerCase(), variable.progId); }
    }
    const missingSet = findMissingSet(page, comTypes);

    // ── The parser's checks, on the page bound with its includes ──
    const host: ScopeHost = {
        read,
        resolve: (directive, fromPath) => resolveIncludeDirective(directive, fromPath, rootOf(fromPath)),
        parse,
        defaultIncludes: () => request.defaultIncludes,
    };
    const bound = bindAt(host, docPath);
    if (!bound) { return { missingSet, checks: [] }; }

    // An <object runat="server"> in global.asa gives every page that object.
    const globalAsa = read(path.join(rootOf(docPath), 'global.asa'));
    const builtins = globalAsa ? new Set([...BUILTIN_NAMES, ...objectTagIds(globalAsa)]) : BUILTIN_NAMES;

    return { missingSet, checks: checkPage(bound, docPath, builtins) };
}
