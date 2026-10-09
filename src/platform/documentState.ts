/**
 * documentState.ts
 *
 * What every provider asks of a page before it does anything else — its text,
 * and which zone (ASP, CSS, JavaScript or HTML) an offset is in — read once per
 * version of the document and shared.
 *
 * VS Code builds a new string for every `document.getText()`, and getZone
 * rescans the page from its first character for every offset, so each provider
 * asking for itself cost a copy of the page and a scan per question, several
 * times per keystroke. Here the first question after an edit pays for one scan
 * of the page; the rest are a binary search.
 *
 * Keyed by the document object, so a closed page's state goes with it.
 *
 * Also here: which files are open, and their unsaved text, for the code that
 * reads a page's includes.
 */

import * as vscode from 'vscode';
import { createZoneResolver, type Zone, type ZoneResolver } from '../core/zoneUtils';
import { isInVbStringOrComment } from '../core/vbLexical';
import { aspCodeStartOnLine } from './documentHelper';
import { pathKey } from '../core/paths';

interface State {
    version: number;
    text: string;
    zones?: ZoneResolver;
}

const states = new WeakMap<vscode.TextDocument, State>();

function stateOf(document: vscode.TextDocument): State {
    let state = states.get(document);
    if (!state || state.version !== document.version) {
        state = { version: document.version, text: document.getText() };
        states.set(document, state);
    }
    return state;
}

/** The document's text, read once per version. */
export function textOf(document: vscode.TextDocument): string {
    return stateOf(document).text;
}

/** The document's zones, scanned once per version. */
export function zonesFor(document: vscode.TextDocument): ZoneResolver {
    const state = stateOf(document);
    return (state.zones ??= createZoneResolver(state.text));
}

/** Where the caret is, as every provider needs to know before it answers. */
export interface CaretContext {
    offset: number;
    zone: Zone;
    /** True inside a VBScript string or comment, where a word is data, not code. Only ever true in the asp zone. */
    inVbStringOrComment: boolean;
}

export function contextAt(document: vscode.TextDocument, position: vscode.Position): CaretContext {
    const offset = document.offsetAt(position);
    const zone = zonesFor(document).zoneAt(offset);
    const line = document.lineAt(position.line).text;
    const inVbStringOrComment = zone === 'asp'
        && isInVbStringOrComment(line, position.character, aspCodeStartOnLine(line, position.character));
    return { offset, zone, inVbStringOrComment };
}

// ── Files open in the editor ─────────────────────────────────────────────────
// An include open with unsaved changes counts as the editor shows it, not as it
// was last saved — the way language servers treat an open dependency — even
// though IIS reads the saved file.

/** The document open for the file `fsPath`, if there is one. */
export function openDocument(fsPath: string): vscode.TextDocument | undefined {
    const key = pathKey(fsPath);
    return vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && pathKey(d.uri.fsPath) === key);
}

/** The unsaved text of open files, for a thread that cannot ask the editor. */
export interface OpenBuffers {
    /** Text by pathKey. A saved file is left out: the disk holds the same text. */
    texts: Record<string, string>;
    /** The document version each text was read at, by pathKey. */
    versions: Map<string, number>;
}

/** Every file open with unsaved changes, other than `except`. */
export function openBuffers(except?: vscode.TextDocument): OpenBuffers {
    const texts: Record<string, string> = {};
    const versions = new Map<string, number>();
    for (const document of vscode.workspace.textDocuments) {
        if (document === except || !document.isDirty || document.uri.scheme !== 'file') { continue; }
        const key = pathKey(document.uri.fsPath);
        texts[key] = document.getText();
        versions.set(key, document.version);
    }
    return { texts, versions };
}
