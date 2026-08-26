/**
 * editUtils.ts
 *
 * Turning formatted text back into TextEdits.
 *
 * Two things matter here:
 *   • Only the lines that actually moved may be replaced. Replacing the whole
 *     document marks every line as changed in the gutter/overview ruler and
 *     jumps the caret to the end of the file.
 *   • The edits must be written with the DOCUMENT's line endings. Prettier
 *     normalises its output (and the VBScript passes join on '\n'), so a
 *     CRLF-saved file would otherwise come back LF-only — which both converts
 *     the file's line endings and makes every single line differ, defeating the
 *     line-level diff above.
 */

import * as vscode from 'vscode';

/** The line-ending sequence a document is currently saved with. */
export function documentEol(document: vscode.TextDocument): string {
    return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/**
 * Resolves the line ending to write, from the `prettier.endOfLine` setting.
 * `auto` (the default) keeps the document's own line endings — the setting only
 * forces a conversion when the user explicitly picks one.
 */
export function resolveEol(setting: string, document: vscode.TextDocument): string {
    switch (setting) {
        case 'lf':   return '\n';
        case 'crlf': return '\r\n';
        case 'cr':   return '\r';
        default:     return documentEol(document);
    }
}

/** Normalises every line ending in `text` to '\n' so texts can be diffed line by line. */
export function toLf(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

/** Position of the very end of the document (last line, last character). */
function documentEnd(document: vscode.TextDocument): vscode.Position {
    const lastLine = Math.max(0, document.lineCount - 1);
    return new vscode.Position(lastLine, document.lineAt(lastLine).text.length);
}

/**
 * Returns line-level TextEdits instead of replacing the whole document, so only
 * the lines that really changed are touched. Ctrl+Z still undoes everything in
 * one step.
 *
 * `original` and `formatted` must both be '\n'-normalised (see toLf) — line
 * indices then line up with the document's own, whatever it is saved with — and
 * `eol` is the line ending the replacement text is written with.
 */
export function computeLineEdits(
    document:  vscode.TextDocument,
    original:  string,
    formatted: string,
    eol:       string,
): vscode.TextEdit[] {
    const originalLines  = original.split('\n');
    const formattedLines = formatted.split('\n');
    const edits: vscode.TextEdit[] = [];

    let i = 0;
    while (i < Math.max(originalLines.length, formattedLines.length)) {
        if (originalLines[i] === formattedLines[i]) { i++; continue; }

        let j = i + 1;
        while (
            j < Math.max(originalLines.length, formattedLines.length) &&
            originalLines[j] !== formattedLines[j]
        ) { j++; }

        const endLine  = Math.min(j, originalLines.length);
        const newText  = formattedLines.slice(i, j).join(eol);
        const startPos = new vscode.Position(i, 0);
        const endPos   = endLine < originalLines.length
            ? new vscode.Position(endLine, 0)
            : documentEnd(document);

        edits.push(vscode.TextEdit.replace(
            new vscode.Range(startPos, endPos),
            newText + (endLine < originalLines.length ? eol : '')
        ));
        i = j;
    }

    return edits;
}
