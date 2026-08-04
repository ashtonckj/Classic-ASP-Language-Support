import * as vscode from 'vscode';

/**
 * Replaces every <%...%> block in a string with an equal-length run of spaces.
 * This preserves character offsets so that lastIndexOf / indexOf results remain
 * valid, while preventing <% and %> from being mistaken for HTML brackets.
 */
function stripAspBlocks(text: string): string {
    return text.replace(/<%[\s\S]*?%>/g, match => ' '.repeat(match.length));
}

/**
 * Returns true when `textBefore` (everything on the line up to the cursor) is
 * inside a quoted HTML attribute value.
 *
 * Scans forward tracking quote state so that a literal `<` typed inside a value
 * (e.g. href="<") is never mistaken for a tag opener. Only `<` characters that
 * appear *outside* quotes are treated as potential tag openers.
 */
export function isInsideAttrValue(textBefore: string): boolean {
    let inQuote: string | null = null;
    let lastTagOpen = -1;

    for (let i = 0; i < textBefore.length; i++) {
        const ch = textBefore[i];
        if (inQuote) {
            if (ch === inQuote) { inQuote = null; }
        } else {
            if (ch === '"' || ch === "'") { inQuote = ch; }
            else if (ch === '<') {
                const next = textBefore[i + 1];
                if (next && /[a-zA-Z\/]/.test(next)) {
                    lastTagOpen = i;
                    inQuote = null; // entering a new tag context resets quote state
                }
            }
        }
    }

    if (lastTagOpen === -1) { return false; }

    // Rescan from the last real tag opener to determine the final quote state
    inQuote = null;
    for (const ch of textBefore.slice(lastTagOpen)) {
        if (!inQuote && (ch === '"' || ch === "'")) { inQuote = ch; }
        else if (inQuote && ch === inQuote) { inQuote = null; }
    }
    return inQuote !== null;
}

/**
 * Returns the name of the HTML tag the cursor is currently inside (between `<`
 * and `>`), or null if the cursor is not inside an opening tag.
 *
 * ASP blocks are stripped before scanning so `<%` / `%>` are never mistaken
 * for HTML angle brackets.
 */
export function getCurrentTagName(document: vscode.TextDocument, position: vscode.Position): string | null {
    const fullText = document.getText();
    const offset = document.offsetAt(position);
    // Strip ASP blocks so that <% and %> are never mistaken for HTML brackets
    const beforeCursor = stripAspBlocks(fullText.substring(0, offset));

    const lastOpenBracket = beforeCursor.lastIndexOf('<');
    if (lastOpenBracket === -1) { return null; }

    // If there is a `>` between the last `<` and the cursor, we're not inside a tag
    const textAfterBracket = beforeCursor.substring(lastOpenBracket);
    if (textAfterBracket.includes('>')) { return null; }

    // Extract tag name from the original (un-stripped) text at the same position
    const originalAfterBracket = fullText.substring(0, offset).substring(lastOpenBracket);
    const tagMatch = originalAfterBracket.match(/^<\/?(\w+)/);
    return tagMatch ? tagMatch[1] : null;
}

/**
 * Returns true when the cursor is positioned inside an HTML opening tag (i.e.
 * between `<tagname` and the closing `>`), meaning attribute completions are
 * appropriate.
 *
 * ASP blocks are stripped so `<%...%>` angle brackets don't confuse the scan.
 */
export function isInsideTagForAttributes(document: vscode.TextDocument, position: vscode.Position): boolean {
    const fullText = document.getText();
    const offset = document.offsetAt(position);
    const beforeCursor = stripAspBlocks(fullText.substring(0, offset));

    const lastOpenBracket = beforeCursor.lastIndexOf('<');
    const lastCloseBracket = beforeCursor.lastIndexOf('>');

    // Inside a tag when the last `<` comes after the last `>`
    return lastOpenBracket > lastCloseBracket;
}

/**
 * Returns the text on the current line up to (but not including) the cursor.
 */
export function getTextBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    return document.lineAt(position.line).text.substring(0, position.character);
}

/**
 * Returns true when `col` on `lineText` sits inside a VBScript string literal
 * ("…", with "" as an escaped quote) or after the start of a `'` comment. Used to
 * suppress IntelliSense / go-to-definition where the token is data, not code
 * (e.g. `x = "rs."` or a `' Response.` comment). Scans only the current line,
 * which is sufficient: VBScript strings and `'` comments never span lines.
 */
export function isInsideVbStringOrComment(lineText: string, col: number): boolean {
    let inStr = false;
    for (let i = 0; i < col && i < lineText.length; i++) {
        const ch = lineText[i];
        if (ch === '"') {
            if (inStr && lineText[i + 1] === '"') { i++; continue; } // "" escaped quote
            inStr = !inStr;
        } else if (!inStr && ch === "'") {
            return true; // rest of the line is a comment
        }
    }
    return inStr;
}

/**
 * Returns the word at the cursor position, or an empty string if there is none.
 */
export function getWordAtPosition(document: vscode.TextDocument, position: vscode.Position): string {
    const range = document.getWordRangeAtPosition(position);
    return range ? document.getText(range) : '';
}