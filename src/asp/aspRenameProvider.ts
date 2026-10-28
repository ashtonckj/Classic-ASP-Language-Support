import * as vscode from 'vscode';
import { ASP_OBJECT_NAMES } from '../constants/aspKeywords';
import { isReservedWord } from '../vbscript/parser';
import { contextAt } from '../platform/documentState';
import { findSites, resolveAt, sitesIn } from '../vbscript/references';
import { editorWorkspace, siteToLocation } from './vbscriptWorkspace';
import type { WorkspaceHost } from '../vbscript/references';
import { pathKey } from '../core/paths';

// ─────────────────────────────────────────────────────────────────────────────
// Where a symbol is used
//
// Rename and Find All References ask the same question, so they share one
// answer, which comes from the parser (src/vbscript/references.ts). A local
// stays inside its own procedure. A page-wide name reaches every page whose
// includes can see it, except a procedure that declares its own copy.
// Strings, comments, HTML and members of other objects are never touched,
// because the parser only ever sees names in code.
// ─────────────────────────────────────────────────────────────────────────────

/** One place a symbol is written; `declaration` marks where it is declared. */
export interface SymbolLocation {
    uri:         vscode.Uri;
    range:       vscode.Range;
    declaration: boolean;
}

/**
 * The word under the caret, or why it cannot be a VBScript name: it has to be
 * code, not HTML, a string or a comment, and not a keyword.
 */
function wordAt(
    document: vscode.TextDocument,
    position: vscode.Position,
): { word: string; range: vscode.Range } | { reason: string } {
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) { return { reason: 'No symbol found at cursor position.' }; }
    const word = document.getText(range);

    // The asp zone is both <% %> blocks and <script language="vbscript"> blocks.
    const caret = contextAt(document, range.start);
    if (caret.zone !== 'asp') {
        return { reason: 'Rename is only supported for VBScript symbols inside ASP blocks.' };
    }
    if (caret.inVbStringOrComment) {
        return { reason: `"${word}" is inside a string or a comment, not code.` };
    }
    if (isKeyword(word)) {
        return { reason: `"${word}" is a VBScript keyword and cannot be renamed.` };
    }
    return { word, range };
}

/** A word no page can declare, or the name of an ASP object, which a page should not shadow. */
const isKeyword = (word: string) => isReservedWord(word.toLowerCase()) || ASP_OBJECT_NAMES.has(word.toLowerCase());

const notASymbol = (word: string) => `"${word}" is not a recognised VBScript symbol.`;

/**
 * Every place the VBScript symbol at `position` is used, in every file that can
 * see it. `host` reads the workspace's includes afresh unless one is given.
 */
export function findSymbolLocations(
    document: vscode.TextDocument,
    position: vscode.Position,
    host: WorkspaceHost = editorWorkspace(document, { freshIncludes: true }),
): SymbolLocation[] {
    const found = wordAt(document, position);
    if ('reason' in found) { return []; }

    const sites = findSites(host, document.uri.fsPath, document.offsetAt(found.range.start)) ?? [];
    return sites.map(site => {
        const { uri, range } = siteToLocation(document, site);
        return { uri, range, declaration: site.declaration };
    });
}

/**
 * Every use of the VBScript name at the caret in this page, as a .vb or .js
 * file highlights them. The page and its includes are bound as for hover, but
 * no other page is read: this runs on every caret move.
 */
export class AspDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
    provideDocumentHighlights(document: vscode.TextDocument, position: vscode.Position): vscode.DocumentHighlight[] | undefined {
        const found = wordAt(document, position);
        if ('reason' in found) { return undefined; }
        const resolved = resolveAt(editorWorkspace(document), document.uri.fsPath, document.offsetAt(found.range.start), false);
        if (!resolved) { return undefined; }
        return sitesIn(resolved.bound, resolved.target)
            .filter(site => pathKey(site.file) === pathKey(document.uri.fsPath))
            .map(site => new vscode.DocumentHighlight(
                new vscode.Range(document.positionAt(site.start), document.positionAt(site.end)),
                site.declaration ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read,
            ));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AspRenameProvider
//
// Implements F2 rename for VBScript functions, subs, variables, constants,
// classes and class members, across the page and every file that shares its
// includes.
//
// prepareRename:    validates the word under the cursor is a renameable symbol.
// provideRenameEdits: rewrites every place findSymbolLocations finds.
// ─────────────────────────────────────────────────────────────────────────────

export class AspRenameProvider implements vscode.RenameProvider {

    // The workspace prepareRename read, so the edits that follow for the same
    // text read every page's includes once between them, not twice.
    private prepared: { document: vscode.TextDocument; version: number; host: WorkspaceHost } | undefined;

    // ── prepareRename ─────────────────────────────────────────────────────────
    // Called before the rename input box appears. Return the current word range
    // so VS Code pre-fills it, or throw to show an error and abort.
    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
        const found = wordAt(document, position);
        if ('reason' in found) { throw new Error(found.reason); }
        const host = editorWorkspace(document, { freshIncludes: true });
        this.prepared = { document, version: document.version, host };
        if (!resolveAt(host, document.uri.fsPath, document.offsetAt(found.range.start))) {
            throw new Error(notASymbol(found.word));
        }
        return { range: found.range, placeholder: found.word };
    }

    // ── provideRenameEdits ────────────────────────────────────────────────────
    // Called after the user confirms the new name. Returns a WorkspaceEdit
    // that replaces every occurrence of the old name in all relevant files.
    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string
    ): vscode.ProviderResult<vscode.WorkspaceEdit> {

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;
        const oldName = document.getText(wordRange);

        // Validate the new name is a legal VBScript identifier.
        if (!/^[a-zA-Z_]\w*$/.test(newName)) {
            vscode.window.showErrorMessage(
                `"${newName}" is not a valid VBScript identifier. ` +
                `Names must start with a letter or underscore and contain only letters, digits, and underscores.`
            );
            return null;
        }

        if (isKeyword(newName)) {
            vscode.window.showErrorMessage(`"${newName}" is a VBScript keyword and cannot be used as an identifier.`);
            return null;
        }

        const prepared = this.prepared;
        this.prepared = undefined;
        const host = prepared?.document === document && prepared.version === document.version ? prepared.host : undefined;

        const edit = new vscode.WorkspaceEdit();
        for (const location of findSymbolLocations(document, position, host)) {
            edit.replace(location.uri, location.range, newName);
        }

        reportCrossFileRename(edit, oldName);

        return edit;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AspReferenceProvider
//
// Find All References (Shift+F12) for the same symbols, over the same scope.
// Without it VS Code had nothing for VBScript, and the word under the caret
// could only be searched for as text — strings, comments, other pages and all.
// ─────────────────────────────────────────────────────────────────────────────

export class AspReferenceProvider implements vscode.ReferenceProvider {
    provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context:  vscode.ReferenceContext,
    ): vscode.Location[] {
        // The kept include graph, as F12 and hover use: reading every page afresh, as rename
        // must, blocked the extension host for seconds, and Copilot asks for references too.
        return findSymbolLocations(document, position, editorWorkspace(document))
            .filter(location => context.includeDeclaration || !location.declaration)
            .map(location => new vscode.Location(location.uri, location.range));
    }
}

/**
 * Tells the user when a rename reached beyond the current file.
 *
 * VS Code applies a rename's WorkspaceEdit in one shot with no confirmation, and
 * nothing in the UI advertises the built-in preview (Ctrl+Shift+Enter instead of
 * Enter in the rename box). Editing several files with no feedback at all is easy
 * to miss until it turns up in a diff, so say what was touched. It is one undo
 * step, which is worth saying too.
 */
function reportCrossFileRename(edit: vscode.WorkspaceEdit, oldName: string): void {
    const entries = edit.entries();
    if (entries.length <= 1) { return; }

    const occurrences = entries.reduce((total, [, edits]) => total + edits.length, 0);
    vscode.window.showInformationMessage(
        `Renamed ${occurrences} occurrence${occurrences === 1 ? '' : 's'} of ` +
        `"${oldName}" across ${entries.length} files. Ctrl+Z undoes all of them.`
    );
}
