/**
 * lexer.ts
 *
 * Turns the VBScript parts of a page into tokens. Offsets are always offsets
 * into the page text, so every token, and every node built from it, points
 * straight back at the source without a mapping step.
 *
 * The rules follow the real VBScript engine (checked against cscript.exe):
 *   - `""` inside a string is an escaped quote; a string cannot span lines.
 *   - `'` and `Rem` start a comment. `x = 1 Rem hi` is a comment too.
 *   - `_` joins the next line, with or without a space before it, but only
 *     when nothing but whitespace follows it: `_ ' note` is an error.
 *   - `&H1F`, `&O17`, a trailing `&` on either, `1.5E-3`, `.5` and `1.`
 *     are numbers; `#1/1/2000#` is a date.
 *   - `[any text]` is an identifier.
 *   - A `.` straight after a name or `)` is member access. A `.` with a
 *     space before it starts a With member (`.Name`), which is why
 *     `x = y .z` is an error and `x = y. z` is not.
 *
 * Keywords are not a token kind. Most VBScript keywords can also be names in
 * some position (`x.End`, `Dim step`), so the parser decides from context.
 *
 * The lexer never throws. Text it cannot read becomes an Invalid token with a
 * message, and the parser reports it.
 */

import { Segment } from './pageSegments';

export const enum TokenKind {
    Identifier,
    Number,
    String,
    Date,
    Punct,      // operators and brackets: + - * / \ ^ & = < > <= >= <> ( ) , . ;
    Newline,
    Colon,
    Output,     // the zero-width start of a `<%= … %>` block
    Html,       // a run of page HTML between two VBScript blocks
    Invalid,
    EOF,
}

export interface Token {
    kind: TokenKind;
    start: number;
    end: number;
    /** Identifiers: lowercase name, without brackets. Punctuation: the operator. Others: the raw text. */
    value: string;
    /** True when whitespace, a line start or a segment start comes right before the token. */
    spaceBefore: boolean;
    /** Identifiers: the name as written, brackets included. */
    text?: string;
    /** `[name]` form. A bracketed identifier is never a keyword. */
    bracketed?: boolean;
    /** Why the token is malformed (an unterminated string, a stray character). */
    error?: string;
}

export interface LexResult {
    tokens: Token[];
    comments: { start: number; end: number }[];
}

const TWO_CHAR_OPS = new Set(['<=', '>=', '<>', '=<', '=>']);
const ONE_CHAR_OPS = '+-*/\\^&=<>(),.;';

function isLetter(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch > '\x7f' && /\p{L}/u.test(ch));
}

function isIdentChar(ch: string): boolean {
    return isLetter(ch) || (ch >= '0' && ch <= '9') || ch === '_';
}

function isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
    return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isSpace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v' || ch === ' ';
}

/**
 * Lexes each segment in order. Every segment ends with a Newline token,
 * because IIS ends a statement wherever a `<% … %>` block closes, and an HTML
 * chunk becomes a statement of its own (a Response.WriteBlock call).
 */
export function tokenize(text: string, segments: Segment[]): LexResult {
    const tokens: Token[] = [];
    const comments: { start: number; end: number }[] = [];

    for (const seg of segments) {
        if (seg.kind === 'html') {
            tokens.push({ kind: TokenKind.Html, start: seg.start, end: seg.end, value: '', spaceBefore: true });
            tokens.push({ kind: TokenKind.Newline, start: seg.end, end: seg.end, value: '', spaceBefore: true });
            continue;
        }
        if (seg.kind === 'output') {
            tokens.push({ kind: TokenKind.Output, start: seg.start, end: seg.start, value: '', spaceBefore: true });
        }
        lexRange(text, seg.start, seg.end, tokens, comments);
        tokens.push({ kind: TokenKind.Newline, start: seg.end, end: seg.end, value: '', spaceBefore: true });
    }

    // The program ends where its last segment does, which is where IIS reports a block left open.
    const end = segments.length > 0 ? segments[segments.length - 1].end : text.length;
    tokens.push({ kind: TokenKind.EOF, start: end, end, value: '', spaceBefore: true });
    return { tokens, comments };
}

function lexRange(
    text: string,
    from: number,
    to: number,
    tokens: Token[],
    comments: { start: number; end: number }[],
): void {
    let i = from;
    let spaceBefore = true;

    const push = (kind: TokenKind, start: number, end: number, value: string, extra?: Partial<Token>): void => {
        tokens.push({ kind, start, end, value, spaceBefore, ...extra });
        spaceBefore = false;
    };

    const lineEnd = (p: number): number => {
        while (p < to && text[p] !== '\n' && text[p] !== '\r') { p++; }
        return p;
    };

    while (i < to) {
        const ch = text[i];

        if (isSpace(ch)) { i++; spaceBefore = true; continue; }

        if (ch === '\r' || ch === '\n') {
            const end = ch === '\r' && text[i + 1] === '\n' && i + 1 < to ? i + 2 : i + 1;
            push(TokenKind.Newline, i, end, '');
            i = end;
            spaceBefore = true;
            continue;
        }

        if (ch === "'") {
            const end = lineEnd(i);
            comments.push({ start: i, end });
            i = end;
            continue;
        }

        if (ch === ':') { push(TokenKind.Colon, i, i + 1, ':'); i++; spaceBefore = true; continue; }

        if (ch === '"') {
            let j = i + 1;
            let closed = false;
            while (j < to) {
                const c = text[j];
                if (c === '"') {
                    if (text[j + 1] === '"' && j + 1 < to) { j += 2; continue; }
                    j++;
                    closed = true;
                    break;
                }
                if (c === '\n' || c === '\r') { break; }
                j++;
            }
            push(TokenKind.String, i, j, text.slice(i, j),
                closed ? undefined : { error: 'Unterminated string constant' });
            i = j;
            continue;
        }

        if (ch === '#') {
            let j = i + 1;
            while (j < to && text[j] !== '#' && text[j] !== '\n' && text[j] !== '\r') { j++; }
            if (j < to && text[j] === '#') {
                push(TokenKind.Date, i, j + 1, text.slice(i, j + 1));
                i = j + 1;
            } else {
                push(TokenKind.Invalid, i, j, text.slice(i, j), { error: 'Unterminated date literal' });
                i = j;
            }
            continue;
        }

        if (ch === '[') {
            let j = i + 1;
            while (j < to && text[j] !== ']' && text[j] !== '\n' && text[j] !== '\r') { j++; }
            if (j < to && text[j] === ']') {
                push(TokenKind.Identifier, i, j + 1, text.slice(i + 1, j).toLowerCase(), { bracketed: true, text: text.slice(i, j + 1) });
                i = j + 1;
            } else {
                push(TokenKind.Invalid, i, j, text.slice(i, j), { error: "Expected ']'" });
                i = j;
            }
            continue;
        }

        if (isLetter(ch)) {
            let j = i + 1;
            while (j < to && isIdentChar(text[j])) { j++; }
            const word = text.slice(i, j).toLowerCase();
            if (word === 'rem') {
                const end = lineEnd(j);
                comments.push({ start: i, end });
                i = end;
                continue;
            }
            push(TokenKind.Identifier, i, j, word, { text: text.slice(i, j) });
            i = j;
            continue;
        }

        if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1] ?? '') && !memberDotHere(tokens, spaceBefore))) {
            i = lexNumber(text, i, to, push);
            continue;
        }

        if (ch === '&' && i + 2 < to) {
            const radix = text[i + 1].toLowerCase();
            const first = text[i + 2];
            if ((radix === 'h' && isHexDigit(first)) || (radix === 'o' && first >= '0' && first <= '7')) {
                let j = i + 2;
                const ok = radix === 'h' ? isHexDigit : (c: string) => c >= '0' && c <= '7';
                while (j < to && ok(text[j])) { j++; }
                if (text[j] === '&' && j < to) { j++; }
                push(TokenKind.Number, i, j, text.slice(i, j));
                i = j;
                continue;
            }
        }

        if (ch === '_') {
            // A continuation: only whitespace may follow on this line.
            let j = i + 1;
            while (j < to && isSpace(text[j])) { j++; }
            if (j < to && (text[j] === '\r' || text[j] === '\n')) {
                j += text[j] === '\r' && text[j + 1] === '\n' ? 2 : 1;
                i = j;
                spaceBefore = true;
                continue;
            }
            push(TokenKind.Invalid, i, i + 1, '_', { error: 'Invalid character' });
            i++;
            continue;
        }

        const two = text.slice(i, i + 2);
        if (i + 1 < to && TWO_CHAR_OPS.has(two)) {
            push(TokenKind.Punct, i, i + 2, two === '=<' ? '<=' : two === '=>' ? '>=' : two);
            i += 2;
            continue;
        }

        if (ONE_CHAR_OPS.includes(ch)) {
            push(TokenKind.Punct, i, i + 1, ch);
            i++;
            continue;
        }

        push(TokenKind.Invalid, i, i + 1, ch, { error: 'Invalid character' });
        i++;
    }
}

/** True when a `.` here would be member access: straight after a name, `)` or `]`. */
function memberDotHere(tokens: Token[], spaceBefore: boolean): boolean {
    if (spaceBefore) { return false; }
    const prev = tokens[tokens.length - 1];
    return !!prev && (prev.kind === TokenKind.Identifier || (prev.kind === TokenKind.Punct && prev.value === ')'));
}

function lexNumber(
    text: string,
    i: number,
    to: number,
    push: (kind: TokenKind, start: number, end: number, value: string, extra?: Partial<Token>) => void,
): number {
    const start = i;
    while (i < to && isDigit(text[i])) { i++; }
    if (i < to && text[i] === '.') {
        i++;
        while (i < to && isDigit(text[i])) { i++; }
    }
    let error: string | undefined;
    if (i < to && (text[i] === 'e' || text[i] === 'E')) {
        let j = i + 1;
        if (text[j] === '+' || text[j] === '-') { j++; }
        if (j < to && isDigit(text[j])) {
            while (j < to && isDigit(text[j])) { j++; }
        } else {
            error = 'Invalid number';
        }
        i = j;
    }
    push(TokenKind.Number, start, i, text.slice(start, i), error ? { error } : undefined);
    return i;
}
