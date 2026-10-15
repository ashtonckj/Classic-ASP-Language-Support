/**
 * indentRules.ts  (vbscript/)
 *
 * The one set of VBScript block rules: which lines open a block, close one, or
 * sit in the middle of one (Else, Case), and where a line continued with `_`
 * lines up; which opener a closer belongs to is the parser's answer
 * (asp/typing/vbIndent findMatchingOpenerIndent). Enter and Tab (asp/typing) and
 * the formatter (formatter/aspFormatter) all read these, so typing and Format
 * Document indent a block the same way.
 *
 * The rules read a line's code: the caller leaves out its comment (and the
 * formatter its strings) first.
 */

import { endsWithContinuation, scanVbLine } from '../core/vbLexical';
import { parseProgram } from './parser';
import { walkStatements } from './symbols';

// ── VBScript block keyword constants ───────────────────────────────────────

// Pure closers: end a block, snap back to opener indent level
export const VBSCRIPT_BLOCK_CLOSERS = /^(End\s+If\b|End\s+Sub\b|End\s+Function\b|End\s+Property\b|End\s+With\b|End\s+Select\b|End\s+Class\b|Next\b|Loop\b|Wend\b)/i;

// Mid-block keywords: close the block above AND open a new block below.
// On Enter they snap to their opener's indent, then give +1 on the next line.
export const VBSCRIPT_MID_BLOCK = /^(ElseIf\b|Else\b|Case\b)/i;

// Exact-match regex for auto-snap (onDidChangeTextDocument)
export const VBSCRIPT_EXACT_CLOSER =
    /^(End\s+If|End\s+Sub|End\s+Function|End\s+Property|End\s+With|End\s+Select|End\s+Class|Next|Loop|Wend|ElseIf(?:\s+.*Then)?|Else|Case(?:\s+Else)?(?:\s+\S.*)?)$/i;

/**
 * True when a line of VBScript leaves a block open, so the next line indents
 * +1, as the parser reads the line: `If x Then` and `Public Sub Foo` open one;
 * `If x Then y = 1` and `If x Then : y = 1` are one-line Ifs, and
 * `For i = 1 To 3 : Next` opens and closes.
 */
export function isBlockOpener(line: string): boolean {
    // A statement continued with `_` is not finished, so it opens nothing yet.
    if (endsWithContinuation(line)) { return false; }
    let open = false;
    walkStatements(parseProgram(line, [{ kind: 'code', start: 0, end: line.length }]).body, s => {
        if ('closer' in s && s.closer === null && !(s.kind === 'If' && s.singleLine)) { open = true; }
    });
    return open;
}

/**
 * The column of the first string literal's opening `"` on a line that ends
 * with `& _`, or -1 when there is none: `    stmt = "SELECT " & _` gives 11.
 * `from` is where the line's VBScript starts, so a quote in the HTML before
 * a `<%` does not count.
 */
export function getStringAlignColumn(lineText: string, from = 0): number {
    return scanVbLine(lineText, from).strings[0]?.start ?? -1;
}
