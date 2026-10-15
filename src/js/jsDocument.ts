/**
 * jsDocument.ts
 *
 * The editor side of the JavaScript features: what every JS provider does
 * with a document before it asks the TypeScript service, which lives on the
 * JS worker (workers/jsAnalysisWorker.ts), anything.
 */

import * as vscode from 'vscode';
import type * as ts from 'typescript';
import { textOf, zonesFor } from '../platform/documentState';
import { queryEmbeddedJs } from '../workers/analysisClient';
import type { JsQueryMethod } from '../workers/jsAnalysisWorker';
import { VIRTUAL_FILENAME, type JsLanguageService } from './jsUtils';

/** The caret as a page offset when it is in a <script> block, else undefined. */
export function jsOffsetAt(document: vscode.TextDocument, at: vscode.Position | number): number | undefined {
    const offset = typeof at === 'number' ? at : document.offsetAt(at);
    return zonesFor(document).zoneAt(offset) === 'js' ? offset : undefined;
}

/**
 * What the JavaScript service's `method` answers about the page as it is now,
 * or undefined when the request was cancelled, the worker could not answer,
 * or the page changed meanwhile, which would put the answer's offsets in the
 * wrong places.
 */
export async function askJs<M extends JsQueryMethod>(
    document: vscode.TextDocument,
    method:   M,
    args:     Parameters<JsLanguageService[M]>,
    token:    vscode.CancellationToken,
): Promise<ReturnType<JsLanguageService[M]> | undefined> {
    const version = document.version;
    const answer = await queryEmbeddedJs(document.uri.toString(), textOf(document), method, args, token);
    return document.version === version && !token.isCancellationRequested ? answer : undefined;
}

/**
 * Where a span TypeScript reports is in the page, or undefined when it is in
 * another file: the generated declarations or the DOM types, neither of which
 * is a place a reader can be sent or an edit applied.
 */
export function jsRange(document: vscode.TextDocument, fileName: string, span: ts.TextSpan): vscode.Range | undefined {
    return fileName === VIRTUAL_FILENAME
        ? new vscode.Range(document.positionAt(span.start), document.positionAt(span.start + span.length))
        : undefined;
}

/**
 * A JSDoc comment as Markdown, the way VS Code's own JavaScript support shows
 * it: the text, then each `@tag`. Untrusted, as it comes from the page.
 */
export function jsDocMarkdown(
    documentation: ts.SymbolDisplayPart[] | undefined,
    tags: ts.JSDocTagInfo[] | undefined,
): string {
    const docsText = documentation?.map(p => p.text).join('') ?? '';
    const tagsText = tags?.map(tag => {
        const body = tag.text?.map(p => p.text).join('') ?? '';
        return body ? `*@${tag.name}* — ${body}` : `*@${tag.name}*`;
    }).join('\n\n') ?? '';
    return [docsText, tagsText].filter(Boolean).join('\n\n');
}
