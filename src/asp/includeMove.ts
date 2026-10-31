import * as vscode from 'vscode';
import * as path from 'path';
import { getVirtualRoot, readIncludeText } from './includeProvider';
import { movedPathLookup, rewriteIncludesAfterMove } from '../core/includeDirectives';
import { getWorkspaceAspFiles } from '../platform/workspaceIndex';
import { isFile, pathKey } from '../core/paths';

// ─────────────────────────────────────────────────────────────────────────────
// #include paths after a file is renamed or moved
//
// Renaming or moving a file in VS Code left every #include that named it
// pointing at nothing, and IIS will not run a page with a missing include. VS
// Code offers to update the imports when a JavaScript file moves; this offers
// the same for #include.
// ─────────────────────────────────────────────────────────────────────────────

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
    const add = (fsPath: string) => { candidates.set(pathKey(fsPath), fsPath); };
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
