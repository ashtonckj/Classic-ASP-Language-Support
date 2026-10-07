/**
 * jsDocument.ts
 *
 * The editor side of the JavaScript features: what every JS provider does
 * with a document before it asks the TypeScript service anything. jsUtils.ts
 * holds the vscode-free part, which the JS worker runs too.
 */

import * as vscode from 'vscode';
import { textOf, zonesFor } from '../platform/documentState';
import { prepareJsQuery, type JsQuery } from './jsUtils';

/** The service positioned on `at`, or undefined outside a <script> block. */
export function jsQueryAt(document: vscode.TextDocument, at: vscode.Position | number): JsQuery | undefined {
    const offset = typeof at === 'number' ? at : document.offsetAt(at);
    return prepareJsQuery(textOf(document), offset, zonesFor(document));
}
