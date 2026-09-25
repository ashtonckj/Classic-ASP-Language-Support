import * as vscode from 'vscode';
import { findClosingTag, findTagEnd } from './zoneUtils';

/**
 * The opening tag whose attribute list encloses `offset`, or null when the offset
 * is not inside one.
 *
 * The walk is a small state machine rather than a `lastIndexOf('<')` vs
 * `lastIndexOf('>')` comparison. That comparison counted a `>` inside a quoted
 * attribute value (`title="a > b"`, `onclick="if(a>b)go()"`) as the end of the
 * tag, so attribute IntelliSense went dead for the rest of that tag. It skips:
 *   - HTML comments      <!-- ... -->
 *   - ASP blocks         <% ... %>  (findTagEnd handles those inside a tag)
 *   - <script>/<style> bodies, whose JS/CSS `<` and `>` operators are not markup
 *   - a literal `<` in body text ("qty < 5"), which is not a tag opener
 * and finds each tag's real terminator with findTagEnd, which is quote- and
 * ASP-aware.
 */
function enclosingTag(fullText: string, offset: number): { start: number; name: string | null } | null {
    let i = 0;

    while (i < offset) {
        if (fullText.startsWith('<!--', i)) {
            const end = fullText.indexOf('-->', i + 4);
            i = end === -1 ? offset : end + 3;
            continue;
        }
        if (fullText[i] === '<' && fullText[i + 1] === '%') {
            const end = fullText.indexOf('%>', i + 2);
            i = end === -1 ? offset : end + 2;
            continue;
        }
        if (fullText[i] !== '<') { i++; continue; }

        // A `<` with no tag-name character after it is literal body text, not markup.
        const next = fullText[i + 1];
        if (next === undefined || !/[A-Za-z/!?]/.test(next)) { i++; continue; }

        const nameMatch = /^<(\/?)([A-Za-z][\w:-]*)/.exec(fullText.slice(i, i + 64));
        const tagEnd    = findTagEnd(fullText, i);

        // No terminator before the cursor -> the cursor is inside this tag.
        if (tagEnd === -1 || tagEnd >= offset) {
            return { start: i, name: nameMatch ? nameMatch[2] : null };
        }

        // Raw-text elements: their bodies are JS/CSS, where `<` and `>` are
        // operators. Jump straight to the matching close tag.
        const tagName = nameMatch && !nameMatch[1] ? nameMatch[2].toLowerCase() : '';
        if (tagName === 'script' || tagName === 'style') {
            const { index, length } = findClosingTag(fullText, tagName, tagEnd + 1);
            i = index === -1 ? offset : index + length;
            continue;
        }

        i = tagEnd + 1;
    }

    return null;
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
 * and `>`), or null if the cursor is not inside a tag.
 */
export function getCurrentTagName(document: vscode.TextDocument, position: vscode.Position): string | null {
    const fullText = document.getText();
    const offset   = document.offsetAt(position);
    return enclosingTag(fullText, offset)?.name ?? null;
}

/**
 * Returns true when the cursor is positioned inside an HTML tag (i.e. between
 * `<tagname` and the closing `>`), meaning attribute completions are appropriate.
 */
export function isInsideTagForAttributes(document: vscode.TextDocument, position: vscode.Position): boolean {
    const fullText = document.getText();
    const offset   = document.offsetAt(position);
    return enclosingTag(fullText, offset) !== null;
}

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

/**
 * Returns true when `col` sits inside a VBScript string literal ("…", with ""
 * as an escaped quote). Scanning starts at `from`, which callers set to the
 * beginning of the VBScript on the line (see aspCodeStartOnLine).
 */
export function isInsideVbString(lineText: string, col: number, from: number = 0): boolean {
    let inStr = false;
    for (let i = from; i < col && i < lineText.length; i++) {
        if (lineText[i] === '"') {
            if (inStr && lineText[i + 1] === '"') { i++; continue; } // "" escaped quote
            inStr = !inStr;
        }
    }
    return inStr;
}

/**
 * Returns true when `col` on `lineText` sits inside a VBScript string literal
 * ("…", with "" as an escaped quote) or after the start of a `'` comment. Used to
 * suppress IntelliSense / go-to-definition where the token is data, not code
 * (e.g. `x = "rs."` or a `' Response.` comment). Scans only the current line,
 * which is sufficient: VBScript strings and `'` comments never span lines — and
 * only from the start of that line's VBScript, so HTML text sharing the line
 * cannot fake a comment.
 */
export function isInsideVbStringOrComment(lineText: string, col: number): boolean {
    let inStr = false;
    for (let i = aspCodeStartOnLine(lineText, col); i < col && i < lineText.length; i++) {
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

// True when line[i..] begins a legacy `REM` comment: the word REM at a statement
// boundary (start of line, or right after a `:` separator). The boundary check
// avoids matching identifiers that merely contain "rem" (e.g. `remainder`).
export function isRemAt(line: string, i: number): boolean {
    const ch = line[i];
    if (ch !== 'r' && ch !== 'R') { return false; }
    return /^rem\b/i.test(line.slice(i)) && /(^|:)\s*$/.test(line.slice(0, i));
}

/**
 * A line of VBScript with its string literals and its comment taken out, so
 * what is left is code: a keyword inside "…" or after ' (or REM) cannot be
 * mistaken for one that is really there.
 */
export function removeStrings(line: string): string {
    let result = '';
    let inStr  = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') {
            if (inStr && i + 1 < line.length && line[i + 1] === '"') { i++; continue; } // "" is an escaped quote
            inStr = !inStr;
        } else if (!inStr) {
            if (line[i] === "'" || isRemAt(line, i)) { break; }
            result += line[i];
        }
    }
    return result;
}

/**
 * The VBScript statements on one line, each with its offset in the line: the
 * code inside `<% %>` (or all of it, inside a block or a server-side script),
 * split at `:` and cut at a comment. `<%= %>` is an output expression, not a
 * statement, so it is skipped.
 */
export function vbStatementsOnLine(line: string, startsInAsp: boolean): { text: string; col: number }[] {
    const statements: { text: string; col: number }[] = [];
    let inAsp     = startsInAsp;
    let output    = false;
    let inString  = false;
    let comment   = false;
    let start     = 0;

    const flush = (end: number) => {
        if (inAsp && !output && end > start) { statements.push({ text: line.slice(start, end), col: start }); }
    };

    for (let i = 0; i < line.length; i++) {
        // ASP ends a block at the first %>, even one inside a string.
        if (inAsp && line.startsWith('%>', i)) {
            if (!comment) { flush(i); }
            inAsp = false; output = false; inString = false; comment = false;
            i++;
            continue;
        }
        if (!inAsp) {
            if (line.startsWith('<%', i)) {
                inAsp  = true;
                output = /^<%\s*=/.test(line.slice(i));
                start  = i + 2;
                i++;
            }
            continue;
        }
        if (comment) { continue; }

        const ch = line[i];
        if (inString) {
            if (ch === '"') {
                if (line[i + 1] === '"') { i++; } else { inString = false; }
            }
        } else if (ch === '"') {
            inString = true;
        } else if (ch === "'" || isRemAt(line, i)) {
            flush(i);
            comment = true;
        } else if (ch === ':') {
            flush(i);
            start = i + 1;
        }
    }
    if (!comment) { flush(line.length); }
    return statements;
}
