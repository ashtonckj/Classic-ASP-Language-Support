/**
 * editing.ts  (asp/typing/)
 *
 * What every typing helper does to the editor: the indent unit it inserts, and
 * an edit followed by a caret move that only happens when the edit did.
 */

import * as vscode from 'vscode';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the indent unit string from editor options.
 * Shared by Enter and Tab handlers to avoid duplicating those 3 lines.
 */
export function getIndentUnit(editor: vscode.TextEditor): string {
    const tabSize = editor.options.tabSize as number || 4;
    const useSpaces = editor.options.insertSpaces !== false;
    return useSpaces ? ' '.repeat(tabSize) : '\t';
}

/**
 * Replaces `at` (a range, or nothing at a position) with `text`, then puts the
 * caret at `caret`. The caret moves only when the edit was applied: an edit
 * VS Code turned down — the document changed under it — must not leave the
 * caret somewhere the text never went.
 */
export async function insertAndPlaceCaret(
    editor: vscode.TextEditor,
    at: vscode.Position | vscode.Range,
    text: string,
    caret: vscode.Position,
): Promise<boolean> {
    const applied = await editor.edit(edit => {
        if (at instanceof vscode.Range) { edit.replace(at, text); } else { edit.insert(at, text); }
    });
    if (applied) { editor.selection = new vscode.Selection(caret, caret); }
    return applied;
}
