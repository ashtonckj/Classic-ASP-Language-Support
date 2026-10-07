import * as vscode from 'vscode';
import { collectIncludeSymbols, configuredVirtualRoot, defaultIncludeCandidates, getVirtualRoot, readIncludeText, resolveDirectIncludes } from './includeProvider';
import { getWorkspaceAspFiles } from './aspWorkspaceSymbolProvider';
import { resolveIncludeDirective } from '../core/includeDirectives';
import { parsePage, type ParsedPage } from '../vbscript/symbols';
import type { WorkspaceHost } from '../vbscript/references';
import { analysePage, type PageAnalysis } from '../vbscript/pageAnalysis';
import { checkPageFiles, type ChecksRequest, type PageChecks } from '../vbscript/pageChecks';
import { analyseVbscriptPage, checkVbscriptPage, vbscriptWorkerUsable } from '../workers/analysisClient';

// ─────────────────────────────────────────────────────────────────────────────
// The workspace as the VBScript parser sees it
//
// Rename, Find All References and Go to Definition bind a page with its
// includes (src/vbscript/references.ts). This gives them the files: the open
// buffer where there is one, so unsaved edits count, and the file on disk
// otherwise.
// ─────────────────────────────────────────────────────────────────────────────

/** Recently parsed files, so asking twice about one page does not parse its includes twice. */
const parsed = new Map<string, ParsedPage>();
const PARSED_LIMIT = 300;

function parseCached(fsPath: string, text: string): ParsedPage {
    const key = fsPath.toLowerCase();
    const known = parsed.get(key);
    if (known && known.text === text) { return known; }
    const page = parsePage(text);
    parsed.delete(key);
    parsed.set(key, page);
    if (parsed.size > PARSED_LIMIT) { parsed.delete(parsed.keys().next().value!); }
    return page;
}

/**
 * Which files include which, over the whole workspace, keyed by lower-cased
 * path. `openPath`/`openText` put the current (possibly unsaved) buffer in, so
 * an include the user has just typed already counts.
 */
function workspaceIncludedBy(openPath: string, openText: string): Map<string, string[]> {
    const includedBy = new Map<string, string[]>();
    const done = new Set<string>();
    const add = (fsPath: string, text: string) => {
        if (done.has(fsPath.toLowerCase())) { return; }
        done.add(fsPath.toLowerCase());
        for (const target of resolveDirectIncludes(text, fsPath)) {
            const list = includedBy.get(target.toLowerCase());
            if (list) { list.push(fsPath); } else { includedBy.set(target.toLowerCase(), [fsPath]); }
        }
    };

    add(openPath, openText);
    // The same list Ctrl+T searches, so a page kept in a .html file through
    // files.associations counts too.
    for (const fsPath of getWorkspaceAspFiles()) { add(fsPath, readIncludeText(fsPath) ?? ''); }
    return includedBy;
}

/**
 * The last include graph, kept for a few seconds: Go to Definition runs on
 * every Ctrl+hover, and a rename asks twice, first to check the name and
 * then to change it. Editing the page itself starts a new graph.
 */
let lastGraph: { key: string; at: number; includedBy: Map<string, string[]> } | null = null;
const GRAPH_FRESH_MS = 5000;

function includeGraphFor(document: vscode.TextDocument): Map<string, string[]> {
    const key = `${document.uri.toString()}@${document.version}`;
    if (lastGraph && lastGraph.key === key && Date.now() - lastGraph.at < GRAPH_FRESH_MS) { return lastGraph.includedBy; }
    const includedBy = workspaceIncludedBy(document.uri.fsPath, document.getText());
    lastGraph = { key, at: Date.now(), includedBy };
    return includedBy;
}

/**
 * The files the parser reads for `document`. The workspace's includes are
 * only scanned when something asks which files include a file, which rename
 * does and Go to Definition mostly does not.
 */
export function editorWorkspace(document: vscode.TextDocument): WorkspaceHost {
    const docPath = document.uri.fsPath;
    const docText = document.getText();

    return {
        read: fsPath => fsPath.toLowerCase() === docPath.toLowerCase() ? docText : readIncludeText(fsPath),
        resolve: (directive, fromPath) => resolveIncludeDirective(directive, fromPath, getVirtualRoot(fromPath)),
        parse: parseCached,
        defaultIncludes: rootPath => defaultIncludeCandidates(getVirtualRoot(rootPath)),
        includedBy: fsPath => includeGraphFor(document).get(fsPath.toLowerCase()) ?? [],
    };
}

/** A page's symbols and blocks, read for the document's text at `version`. */
export interface AnalysedPage extends PageAnalysis { version: number; }

/**
 * The page's own symbols and blocks, read on the VBScript worker thread, for
 * exactly the text the document holds when this returns. A page edited while
 * the worker read it is asked about again. Undefined when the document closed,
 * `token` was cancelled, or the page kept changing.
 */
export async function analysedPage(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<AnalysedPage | undefined> {
    const docPath = document.uri.fsPath;
    for (let attempt = 0; attempt < 5; attempt++) {
        if (document.isClosed || token?.isCancellationRequested) { return undefined; }
        const version = document.version;
        const text = document.getText();

        // A worker that cannot start is no reason to lose these features.
        if (!vbscriptWorkerUsable()) { return { version, ...analysePage(parseCached(docPath, text), docPath) }; }

        const analysis = await analyseVbscriptPage(document.uri.toString(), text, docPath);
        if (analysis && !document.isClosed && document.version === version) { return { version, ...analysis }; }
    }
    return undefined;
}

/** Missing Set and the parser's checks, worked out for the document's text at `version`. */
export interface CheckedPage extends PageChecks { version: number; }

/**
 * Missing Set and the parser's checks for the page, worked out on the
 * VBScript worker thread with its includes. Undefined when a newer request
 * superseded this one or the worker could not answer.
 */
export async function checkedPage(document: vscode.TextDocument): Promise<CheckedPage | undefined> {
    const version = document.version;
    const docPath = document.uri.fsPath;

    // The worker reads files from disk; an include open with unsaved changes
    // counts as the editor shows it.
    const openFiles: Record<string, string> = {};
    for (const open of vscode.workspace.textDocuments) {
        if (open.isDirty && open !== document && open.uri.scheme === 'file') { openFiles[open.uri.fsPath.toLowerCase()] = open.getText(); }
    }

    const request: ChecksRequest = {
        text: document.getText(),
        docPath,
        configuredRoot: configuredVirtualRoot(),
        defaultIncludes: defaultIncludeCandidates(getVirtualRoot(docPath)),
        openFiles,
        includeComVariables: collectIncludeSymbols(document).comVariables.map(({ name, progId }) => ({ name, progId })),
    };

    // A worker that cannot start is no reason to lose the checks.
    const result = vbscriptWorkerUsable()
        ? await checkVbscriptPage(document.uri.toString(), request)
        : checkPageFiles(request, parseCached);
    return result && { version, ...result };
}
