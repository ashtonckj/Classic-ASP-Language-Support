import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getVirtualRoot, readIncludeText } from './includeProvider';
import { movedPathLookup, rewriteIncludesAfterMove } from '../core/includeDirectives';
import { getWorkspaceAspFiles } from './aspWorkspaceSymbolProvider';
import { getZone } from '../core/zoneUtils';
import { VBSCRIPT_KEYWORDS_SET } from '../constants/aspKeywords';
import { isInsideVbStringOrComment } from '../platform/documentHelper';
import { findSites, resolveAt } from '../vbscript/references';
import { editorWorkspace } from './vbscriptWorkspace';

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

    // getZone covers both <% %> blocks and <script language="vbscript"> blocks.
    if (getZone(document.getText(), document.offsetAt(position)) !== 'asp') {
        return { reason: 'Rename is only supported for VBScript symbols inside ASP blocks.' };
    }
    if (isInsideVbStringOrComment(document.lineAt(range.start.line).text, range.start.character)) {
        return { reason: `"${word}" is inside a string or a comment, not code.` };
    }
    if (VBSCRIPT_KEYWORDS_SET.has(word.toLowerCase())) {
        return { reason: `"${word}" is a VBScript keyword and cannot be renamed.` };
    }
    return { word, range };
}

const notASymbol = (word: string) => `"${word}" is not a recognised VBScript symbol.`;

/** Every place the VBScript symbol at `position` is used, in every file that can see it. */
export function findSymbolLocations(document: vscode.TextDocument, position: vscode.Position): SymbolLocation[] {
    const found = wordAt(document, position);
    if ('reason' in found) { return []; }

    const docPath = document.uri.fsPath.toLowerCase();
    const sites = findSites(editorWorkspace(document), document.uri.fsPath, document.offsetAt(found.range.start)) ?? [];
    return sites.map(site => site.file.toLowerCase() === docPath
        ? {
            uri:         document.uri,
            range:       new vscode.Range(document.positionAt(site.start), document.positionAt(site.end)),
            declaration: site.declaration,
        }
        : {
            uri:         vscode.Uri.file(site.file),
            range:       new vscode.Range(site.line, site.character, site.line, site.character + site.end - site.start),
            declaration: site.declaration,
        });
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

    // ── prepareRename ─────────────────────────────────────────────────────────
    // Called before the rename input box appears. Return the current word range
    // so VS Code pre-fills it, or throw to show an error and abort.
    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
        const found = wordAt(document, position);
        if ('reason' in found) { throw new Error(found.reason); }
        if (!resolveAt(editorWorkspace(document), document.uri.fsPath, document.offsetAt(found.range.start))) {
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

        if (VBSCRIPT_KEYWORDS_SET.has(newName.toLowerCase())) {
            vscode.window.showErrorMessage(`"${newName}" is a VBScript keyword and cannot be used as an identifier.`);
            return null;
        }

        const edit = new vscode.WorkspaceEdit();
        for (const location of findSymbolLocations(document, position)) {
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
        return findSymbolLocations(document, position)
            .filter(location => context.includeDeclaration || !location.declaration)
            .map(location => new vscode.Location(location.uri, location.range));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// #include paths after a file is renamed or moved
//
// Renaming or moving a file in VS Code left every #include that named it
// pointing at nothing, and IIS will not run a page with a missing include. VS
// Code offers to update the imports when a JavaScript file moves; this offers
// the same for #include.
// ─────────────────────────────────────────────────────────────────────────────

function isFile(fsPath: string): boolean {
    try { return fs.statSync(fsPath).isFile(); } catch { return false; }
}

function positionIn(text: string, offset: number): vscode.Position {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    let line = 0;
    for (let i = 0; i < lineStart; i++) { if (text[i] === '\n') { line++; } }
    return new vscode.Position(line, offset - lineStart);
}

/**
 * The edit that fixes every #include the renames broke: in the pages that
 * include a moved file, and in a moved page's own `file="…"` paths.
 */
export function includeEditsAfterMove(renames: { oldPath: string; newPath: string }[]): vscode.WorkspaceEdit {
    const moved = movedPathLookup(renames);
    const movedBack = movedPathLookup(renames.map(r => ({ oldPath: r.newPath, newPath: r.oldPath })));

    // Where every candidate is now. The workspace index learns of a rename from
    // a file watcher that can run after this, so it may still hold old paths.
    const candidates = new Map<string, string>();
    const add = (fsPath: string) => { candidates.set(fsPath.toLowerCase(), fsPath); };
    for (const fsPath of getWorkspaceAspFiles()) { add(moved(fsPath) ?? fsPath); }
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && doc.languageId === 'asp') { add(doc.uri.fsPath); }
    }
    for (const { newPath } of renames) { if (isFile(newPath)) { add(newPath); } }

    const edit = new vscode.WorkspaceEdit();
    for (const newDocPath of candidates.values()) {
        const text = readIncludeText(newDocPath);
        if (!text || !text.includes('#include')) { continue; }

        const oldDocPath = movedBack(newDocPath) ?? newDocPath;
        const rewrites = rewriteIncludesAfterMove(
            text, oldDocPath, newDocPath, getVirtualRoot(newDocPath), moved, isFile,
        );

        const uri = vscode.Uri.file(newDocPath);
        for (const rewrite of rewrites) {
            edit.replace(uri, new vscode.Range(positionIn(text, rewrite.start), positionIn(text, rewrite.end)), rewrite.newPath);
        }
    }
    return edit;
}

/** Asks, after a rename in VS Code, whether to fix the #include paths it broke. */
export function registerIncludeUpdatesOnRename(): vscode.Disposable {
    return vscode.workspace.onDidRenameFiles(async event => {
        const renames = event.files
            .filter(f => f.oldUri.scheme === 'file' && f.newUri.scheme === 'file')
            .map(f => ({ oldPath: f.oldUri.fsPath, newPath: f.newUri.fsPath }));
        if (renames.length === 0) { return; }

        const edit = includeEditsAfterMove(renames);
        if (edit.size === 0) { return; }

        const what  = renames.length === 1 ? `'${path.basename(renames[0].newPath)}'` : `${renames.length} moved files`;
        const where = edit.size === 1 ? '1 file' : `${edit.size} files`;
        const choice = await vscode.window.showInformationMessage(
            `Update #include paths for ${what}? This changes ${where}.`, 'Yes', 'No',
        );
        if (choice === 'Yes') { await vscode.workspace.applyEdit(edit); }
    });
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
