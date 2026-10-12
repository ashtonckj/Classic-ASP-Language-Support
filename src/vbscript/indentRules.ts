/**
 * indentRules.ts  (vbscript/)
 *
 * The one set of VBScript block rules: which lines open a block, close one, or
 * sit in the middle of one (Else, Case), which opener each closer belongs to,
 * and where a line continued with `_` lines up. Enter and Tab (asp/typing) and
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

// Optional VBScript access modifiers that may precede Sub / Function / Property /
// Class (e.g. `Public Sub`, `Private Function`, `Public Default Property Get`).
const MOD = '(?:(?:Public|Private|Default)\\s+)*';

// Pure closers: end a block, snap back to opener indent level
export const VBSCRIPT_BLOCK_CLOSERS = /^(End\s+If\b|End\s+Sub\b|End\s+Function\b|End\s+Property\b|End\s+With\b|End\s+Select\b|End\s+Class\b|Next\b|Loop\b|Wend\b)/i;

// Mid-block keywords: close the block above AND open a new block below.
// On Enter they snap to their opener's indent level (+snapOffset), then give +1 on the next line.
// ElseIf/Else are peers of If  → snapOffset 0 (same indent as If)
// Case is subordinate to Select Case → snapOffset 1 (one level inside Select Case)
export const VBSCRIPT_MID_BLOCK = /^(ElseIf\b|Else\b|Case\b)/i;

// Exact-match regex for auto-snap (onDidChangeTextDocument)
export const VBSCRIPT_EXACT_CLOSER =
    /^(End\s+If|End\s+Sub|End\s+Function|End\s+Property|End\s+With|End\s+Select|End\s+Class|Next|Loop|Wend|ElseIf(?:\s+.*Then)?|Else|Case(?:\s+Else)?(?:\s+\S.*)?)$/i;

// Maps each closer/mid-block to its matching opener.
// snapOffset: how many extra indent levels to add on top of the opener's indent when snapping.
//   0 = align flush with opener (ElseIf/Else peers with If)
//   1 = one level inside opener (Case sits inside Select Case)
// family: links mid-block siblings so pure closers (End If) skip past them transparently.
export const CLOSER_TO_OPENER: { closer: RegExp; opener: RegExp; isMidBlock?: boolean; snapOffset?: number; family?: string }[] = [
    { closer: /^End\s+If\b/i,       opener: /^If\b.*Then$/i,                            family: 'if' },
    { closer: /^End\s+Sub\b/i,      opener: new RegExp('^' + MOD + 'Sub\\b', 'i') },
    { closer: /^End\s+Function\b/i, opener: new RegExp('^' + MOD + 'Function\\b', 'i') },
    { closer: /^End\s+Property\b/i, opener: new RegExp('^' + MOD + 'Property\\b', 'i') },
    { closer: /^End\s+With\b/i,     opener: /^With\b/i },
    { closer: /^End\s+Select\b/i,   opener: /^Select\s+Case\b/i,                         family: 'select' },
    { closer: /^End\s+Class\b/i,    opener: new RegExp('^' + MOD + 'Class\\b', 'i') },
    { closer: /^Next\b/i,           opener: /^For\b/i },
    { closer: /^Loop\b/i,           opener: /^Do\b/i },
    { closer: /^Wend\b/i,           opener: /^While\b/i },
    // Mid-block If family — peers of If, snap to its indent (snapOffset 0)
    { closer: /^ElseIf\b/i,         opener: /^If\b.*Then$|^ElseIf\b.*Then$/i,           isMidBlock: true, snapOffset: 0, family: 'if' },
    { closer: /^Else\b/i,           opener: /^If\b.*Then$|^ElseIf\b.*Then$/i,           isMidBlock: true, snapOffset: 0, family: 'if' },
    // Mid-block Select family — Case sits one level inside Select Case (snapOffset 1)
    { closer: /^Case\b/i,           opener: /^Select\s+Case\b/i,                         isMidBlock: true, snapOffset: 1, family: 'select' },
];

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
