/**
 * vbLexical.ts
 *
 * One line of VBScript as the parser's lexer (vbscript/lexer.ts) reads it, for
 * the features that look at code a line at a time — the formatter, the typing
 * helpers, signature help and the caret's string-or-comment check. Built on the
 * lexer itself, so its rules (checked against cscript.exe) are written once:
 *
 *   - `"…"` is a string, `""` inside it is a quote, and a string cannot run
 *     past the end of its line.
 *   - `'` starts a comment, and so does the word `Rem` anywhere outside a
 *     string, except as a member name: `x = 1 Rem note` is a comment,
 *     `x = a. Rem` is not.
 *   - `_` joins the next line when nothing but whitespace follows it and it is
 *     not part of a name: `a_` is a name, `"a" _` and `"a"_` continue. After a
 *     comment it continues nothing.
 *
 * Every function takes the line, and optionally `from`, where its VBScript
 * starts: a line can begin with HTML (`<td>it's</td><% x = 1 %>`), whose
 * apostrophes are not comments.
 */

import { tokenize, TokenKind, type Token } from '../vbscript/lexer';

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

const lex = (line: string, from: number) => tokenize(line, [{ kind: 'code', start: from, end: line.length }]);
const isWord = (t: Token, word: string) => t.kind === TokenKind.Identifier && !t.bracketed && t.value === word;

/** Scans one line of VBScript from `from`. */
export function scanVbLine(line: string, from = 0): VbLine {
    const { tokens, comments } = lex(line, from);
    const strings = tokens
        .filter(t => t.kind === TokenKind.String)
        .map(t => ({ start: t.start, end: t.end, closed: !t.error }));
    // With no line break after it, the lexer leaves a continuing `_` as a token of its own.
    const last = tokens[tokens.length - 3];
    const continues = comments.length === 0 && last?.kind === TokenKind.Invalid && last.value === '_';
    return { codeEnd: comments.length > 0 ? comments[0].start : line.length, strings, continues };
}

/** The line split at its comment: `code` before it, `comment` from its `'` or `Rem` on ('' when none). */
export function splitCodeAndComment(line: string, from = 0): { code: string; comment: string } {
    const { codeEnd } = scanVbLine(line, from);
    return { code: line.slice(0, codeEnd), comment: line.slice(codeEnd) };
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

/**
 * The line's code (its comment left off) split at each `:` outside a string:
 * one entry per statement. The rest of a one-line If is the If's own, so
 * `If x Then a : b` is one statement.
 */
export function vbStatements(line: string): string[] {
    const { tokens, comments } = lex(line, 0);
    const codeEnd = comments.length > 0 ? comments[0].start : line.length;
    const parts: string[] = [];
    let start = 0;
    let first: Token | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.kind === TokenKind.Colon) { parts.push(line.slice(start, t.start)); start = t.end; first = undefined; continue; }
        first ??= t;
        const next = tokens[i + 1]?.kind;
        if (isWord(first, 'if') && isWord(t, 'then') && next !== TokenKind.Newline && next !== TokenKind.EOF) { break; }
    }
    parts.push(line.slice(start, codeEnd));
    return parts;
}
