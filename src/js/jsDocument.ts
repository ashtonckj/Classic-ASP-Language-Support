/**
 * jsDocument.ts
 *
 * The editor side of the JavaScript features: what every JS provider does
 * with a document before it asks the TypeScript service anything. jsUtils.ts
 * holds the vscode-free part, which the JS worker runs too.
 */

import * as vscode from 'vscode';
import { textOf, zonesFor } from '../platform/documentState';
import type * as ts from 'typescript';
import { getJsLanguageService, VIRTUAL_FILENAME, type JsLanguageService } from './jsUtils';

/** The service with the page loaded, and the caret, or undefined outside a <script> block. */
export function jsQueryAt(document: vscode.TextDocument, at: vscode.Position | number): { svc: JsLanguageService; offset: number } | undefined {
    const offset = typeof at === 'number' ? at : document.offsetAt(at);
    const zones = zonesFor(document);
    if (zones.zoneAt(offset) !== 'js') { return undefined; }
    const svc = getJsLanguageService();
    svc.loadPage(textOf(document), zones.jsBlocks);
    return { svc, offset };
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
