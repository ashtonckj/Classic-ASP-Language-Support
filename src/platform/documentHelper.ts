import * as vscode from 'vscode';

/**
 * Returns the text on the current line up to (but not including) the cursor.
 */
export function getTextBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    return document.lineAt(position.line).text.substring(0, position.character);
}

/**
 * Case-insensitive index of the first WHOLE-WORD occurrence of `name` in `line`,
 * or -1. Used to place the caret/selection on a symbol rather than on the first
 * substring match (e.g. `count` must not match inside `accountCount`).
 */
export function indexOfWholeWord(line: string, name: string): number {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('\\b' + escaped + '\\b', 'i').exec(line);
    return m ? m.index : -1;
}

/**
 * Index on `lineText` where the VBScript containing `col` begins.
 *
 * A single physical line can mix HTML and script — `<td>it's here</td><% total = 1 %>`.
 * Any line-local scan for VBScript strings or `'` comments must start at the code,
 * not at column 0, or an apostrophe in the surrounding HTML ("it's", `class='box'`)
 * reads as the start of a VBScript comment and everything after it is wrongly
 * treated as commented out.
 *
 * The walk is purely lexical, matching the ASP engine: `<%` opens script and the
 * first `%>` closes it, wherever they appear. Returns 0 when the line contains no
 * `<%` — it is then entirely inside a multi-line block (or a VBScript `<script>`
 * body), so the whole line is code.
 */
export function aspCodeStartOnLine(lineText: string, col: number): number {
    let start = 0;
    let i = 0;

    while (i < col && i < lineText.length) {
        if (lineText[i] === '<' && lineText[i + 1] === '%') {
            i += 2;
            // Skip the marker of an output expression (<%=) or directive (<%@)
            if (lineText[i] === '=' || lineText[i] === '@') { i++; }
            start = i;
            continue;
        }
        if (lineText[i] === '%' && lineText[i + 1] === '>') {
            i += 2;
            start = i; // back in HTML — callers zone-check before relying on this
            continue;
        }
        i++;
    }

    return Math.min(start, col);
}

