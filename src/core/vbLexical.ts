/**
 * vbLexical.ts
 *
 * The lexical rules of one line of VBScript, for the features that read code a
 * line at a time — the formatter, the typing helpers, hover, signature help and
 * the caret guard — so they all agree with each other and with the parser's
 * lexer (vbscript/lexer.ts), whose rules were checked against cscript.exe:
 *
 *   - `"…"` is a string, `""` inside it is a quote, and a string cannot run
 *     past the end of its line.
 *   - `'` starts a comment, and so does the word `Rem`, anywhere outside a
 *     string: `x = 1 Rem note` is a comment too.
 *   - `_` joins the next line when nothing but whitespace follows it and it is
 *     not part of a name: `a_` is a name, `"a" _` and `"a"_` continue. After a
 *     comment it continues nothing.
 *
 * Every function takes the line, and optionally `from`, where its VBScript
 * starts: a line can begin with HTML (`<td>it's</td><% x = 1 %>`), whose
 * apostrophes are not comments.
 *
 * Imports nothing, so a worker can use it.
 */

export interface VbStringRange {
    /** The opening quote. */
    start: number;
    /** Just past the closing quote, or the end of the line when there is none. */
    end: number;
    closed: boolean;
}

export interface VbLine {
    /** Where the comment starts (its `'`, or the R of `Rem`), or the line's length when there is none. */
    codeEnd: number;
    /** Each string literal, quotes included, in order. */
    strings: VbStringRange[];
    /** True when the line ends with a `_` that joins the next line to it. */
    continues: boolean;
}

function isNameChar(ch: string | undefined): boolean {
    return ch !== undefined && /[\p{L}\p{Nd}_]/u.test(ch);
}

/** Scans one line of VBScript from `from`. */
export function scanVbLine(line: string, from = 0): VbLine {
    const strings: VbStringRange[] = [];
    let codeEnd = line.length;
    let i = from;

    while (i < line.length) {
        const ch = line[i];
        if (ch === '"') {
            let j = i + 1;
            let closed = false;
            while (j < line.length) {
                if (line[j] === '"') {
                    if (line[j + 1] === '"') { j += 2; continue; }
                    j++;
                    closed = true;
                    break;
                }
                j++;
            }
            strings.push({ start: i, end: j, closed });
            i = j;
            continue;
        }
        if (ch === "'") { codeEnd = i; break; }
        if (ch === '[') {
            // `[any text]` is a name; a quote or apostrophe inside it is not.
            const close = line.indexOf(']', i + 1);
            i = close === -1 ? line.length : close + 1;
            continue;
        }
        if (isNameChar(ch)) {
            let j = i + 1;
            while (isNameChar(line[j])) { j++; }
            if (j - i === 3 && line.slice(i, j).toLowerCase() === 'rem') { codeEnd = i; break; }
            i = j;
            continue;
        }
        i++;
    }

    let continues = false;
    if (codeEnd === line.length && !(strings.length > 0 && !strings[strings.length - 1].closed)) {
        let k = line.length - 1;
        while (k >= from && /\s/.test(line[k])) { k--; }
        continues = k >= from && line[k] === '_' && !isNameChar(line[k - 1])
            && !(strings.length > 0 && strings[strings.length - 1].end > k);
    }
    return { codeEnd, strings, continues };
}

/** The line split at its comment: `code` before it, `comment` from its `'` or `Rem` on ('' when none). */
export function splitCodeAndComment(line: string, from = 0): { code: string; comment: string } {
    const { codeEnd } = scanVbLine(line, from);
    return { code: line.slice(0, codeEnd), comment: line.slice(codeEnd) };
}

/** True when `col` is inside a string literal: after its opening quote and before its closing one. */
export function isInVbString(line: string, col: number, from = 0): boolean {
    return scanVbLine(line, from).strings.some(s => s.start < col && (col < s.end || !s.closed));
}

/** True when `col` is inside a string literal or a comment, where a word is data, not code. */
export function isInVbStringOrComment(line: string, col: number, from = 0): boolean {
    const scan = scanVbLine(line, from);
    return col > scan.codeEnd || scan.strings.some(s => s.start < col && (col < s.end || !s.closed));
}

/** True when the line ends with a `_` continuation. */
export function endsWithContinuation(line: string, from = 0): boolean {
    return scanVbLine(line, from).continues;
}

/** The line's code with its string literals and its comment taken out, so a keyword left is really there. */
export function codeWithoutStrings(line: string, from = 0): string {
    const scan = scanVbLine(line, from);
    let result = '';
    let pos = from;
    for (const s of scan.strings) {
        result += line.slice(pos, s.start);
        pos = s.end;
    }
    return result + line.slice(pos, scan.codeEnd);
}

/** The code split into string literals and the text between them, in order; nothing is dropped. */
export function vbStringSegments(code: string): { text: string; isString: boolean }[] {
    const parts: { text: string; isString: boolean }[] = [];
    let pos = 0;
    for (const s of scanVbLine(code).strings) {
        if (s.start > pos) { parts.push({ text: code.slice(pos, s.start), isString: false }); }
        parts.push({ text: code.slice(s.start, s.end), isString: true });
        pos = s.end;
    }
    if (pos < code.length) { parts.push({ text: code.slice(pos), isString: false }); }
    return parts;
}

/** The line's code (its comment left off) split at each `:` outside a string: one entry per statement. */
export function vbStatements(line: string): string[] {
    const scan = scanVbLine(line);
    const parts: string[] = [];
    let start = 0;
    let next = 0;
    for (let i = 0; i < scan.codeEnd; i++) {
        const s = scan.strings[next];
        if (s && i === s.start) { i = s.end - 1; next++; continue; }
        if (line[i] === ':') { parts.push(line.slice(start, i)); start = i + 1; }
    }
    parts.push(line.slice(start, scan.codeEnd));
    return parts;
}
