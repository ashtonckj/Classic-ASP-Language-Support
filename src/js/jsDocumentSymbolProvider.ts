/**
 * jsDocumentSymbolProvider.ts  (js/)
 *
 * Document symbols for JavaScript inside <script> blocks in .asp files: the
 * Outline panel and the breadcrumb bar. Which symbols, and how they are named,
 * is jsOutline.ts.
 *
 * Complements aspDocumentSymbolProvider.ts which covers VBScript symbols.
 * Both providers are registered against 'asp' and VS Code merges their results
 * in source order.
 *
 * VS Code asks again after every edit while the Outline or breadcrumbs show.
 * The answer comes from the JS worker, which reads it off the syntax tree it
 * has already parsed for the colouring and squiggles; parsing the script again
 * here took ~80 ms on the extension host for an 8,000-line page. When the
 * worker cannot run, it is worked out here, as it always was.
 */

import * as vscode from 'vscode';
import type * as TS from 'typescript';
import { buildVirtualJsContent, VIRTUAL_FILENAME } from './jsUtils';
import { jsOutline, type JsOutlineKind, type JsOutlineSymbol } from './jsOutline';
import { textOf, zonesFor } from '../platform/documentState';
import { log } from '../platform/log';
import { loadTypeScript } from '../core/lazyModule';
import { analyseEmbeddedJs, jsWorkerUsable } from '../workers/analysisClient';

const KINDS: Record<JsOutlineKind, vscode.SymbolKind> = {
    function:    vscode.SymbolKind.Function,
    class:       vscode.SymbolKind.Class,
    method:      vscode.SymbolKind.Method,
    constructor: vscode.SymbolKind.Constructor,
    property:    vscode.SymbolKind.Property,
    constant:    vscode.SymbolKind.Constant,
    variable:    vscode.SymbolKind.Variable,
};

function toDocumentSymbol(document: vscode.TextDocument, symbol: JsOutlineSymbol): vscode.DocumentSymbol {
    const range     = new vscode.Range(document.positionAt(symbol.start), document.positionAt(symbol.end));
    const selection = new vscode.Range(document.positionAt(symbol.nameStart), document.positionAt(symbol.nameStart + symbol.name.length));
    const converted = new vscode.DocumentSymbol(symbol.name, symbol.detail, KINDS[symbol.kind], range, selection);
    converted.children = symbol.children.map(child => toDocumentSymbol(document, child));
    return converted;
}

/** The outline worked out on this thread: when the worker cannot run, and in the unit tests. */
export function outlineOnHost(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const jsRanges = zonesFor(document).jsBlocks;
    if (jsRanges.length === 0) { return []; }

    const ts: typeof TS = loadTypeScript();
    const { virtualContent, preambleLength } = buildVirtualJsContent(textOf(document), 0, jsRanges);
    // Only the syntax tree is needed — no types — so the script is parsed on
    // its own rather than through the language service hover and completion share.
    const sourceFile = ts.createSourceFile(VIRTUAL_FILENAME, virtualContent, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
    return jsOutline(ts, sourceFile, jsRanges, preambleLength).map(symbol => toDocumentSymbol(document, symbol));
}

export class JsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

    async provideDocumentSymbols(
        document: vscode.TextDocument,
        token:    vscode.CancellationToken,
    ): Promise<vscode.DocumentSymbol[]> {

        if (document.languageId !== 'asp' || zonesFor(document).jsBlocks.length === 0) { return []; }
        if (!jsWorkerUsable()) { return outlineOnHost(document); }

        const version  = document.version;
        const analysis = await analyseEmbeddedJs(document.uri.toString(), textOf(document));
        if (!analysis || token.isCancellationRequested || document.isClosed || document.version !== version) { return []; }
        if (analysis.outlineError) { log.error('JavaScript outline failed', analysis.outlineError); }
        return analysis.outline.map(symbol => toDocumentSymbol(document, symbol));
    }
}
