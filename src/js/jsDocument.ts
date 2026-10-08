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
import { prepareJsQuery, toDocumentSpan, type JsQuery } from './jsUtils';

/** The service positioned on `at`, or undefined outside a <script> block. */
export function jsQueryAt(document: vscode.TextDocument, at: vscode.Position | number): JsQuery | undefined {
    const offset = typeof at === 'number' ? at : document.offsetAt(at);
    return prepareJsQuery(textOf(document), offset, zonesFor(document));
}

/**
 * Where a span TypeScript reports is in the page, or undefined when it is not
 * in the page's own script: in the preamble of declarations the virtual file
 * starts with, or in another file (the DOM types).
 */
export function jsRange(
    document: vscode.TextDocument,
    preambleLength: number,
    fileName: string,
    span: ts.TextSpan,
): vscode.Range | undefined {
    const inPage = toDocumentSpan(fileName, span, preambleLength);
    return inPage && new vscode.Range(document.positionAt(inPage.start), document.positionAt(inPage.end));
}
