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

// ── VBScript block keyword constants ───────────────────────────────────────

// Optional VBScript access modifiers that may precede Sub / Function / Property /
// Class (e.g. `Public Sub`, `Private Function`, `Public Default Property Get`).
// Without this the indenter ignored every access-modified declaration.
export const MOD = '(?:(?:Public|Private|Default)\\s+)*';

// Pure openers: start a block, next line should be +1 indent. Property Get/Let/Set
// is a block just like Sub/Function.
export const VBSCRIPT_BLOCK_OPENERS = new RegExp(
    '^' + MOD + '(If\\b.*Then|For\\b|For\\s+Each\\b|Do\\b|Do\\s+While\\b|Do\\s+Until\\b|While\\b|Sub\\b|Function\\b|Property\\b|With\\b|Select\\s+Case\\b|Class\\b)',
    'i',
);

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
    { closer: /^Next\b/i,           opener: /^For\b|^For\s+Each\b/i },
    { closer: /^Loop\b/i,           opener: /^Do\b|^Do\s+While\b|^Do\s+Until\b/i },
    { closer: /^Wend\b/i,           opener: /^While\b/i },
    // Mid-block If family — peers of If, snap to its indent (snapOffset 0)
    { closer: /^ElseIf\b/i,         opener: /^If\b.*Then$|^ElseIf\b.*Then$/i,           isMidBlock: true, snapOffset: 0, family: 'if' },
    { closer: /^Else\b/i,           opener: /^If\b.*Then$|^ElseIf\b.*Then$/i,           isMidBlock: true, snapOffset: 0, family: 'if' },
    // Mid-block Select family — Case sits one level inside Select Case (snapOffset 1)
    { closer: /^Case\b/i,           opener: /^Select\s+Case\b/i,                         isMidBlock: true, snapOffset: 1, family: 'select' },
];

/**
 * True when a trimmed VBScript line opens a block (so the next line indents +1).
 * A single-line `If … Then <statement>` opens nothing — only a multi-line `If …
 * Then` (optionally followed by just a ' comment) does. Shared by the Enter and
 * Tab handlers so they can never disagree.
 */
export function isBlockOpener(line: string): boolean {
    if (!VBSCRIPT_BLOCK_OPENERS.test(line)) { return false; }
    const isSingleLineIf = /^If\b.+\bThen\s+\S/i.test(line) && !/^If\b.+\bThen\s*'/i.test(line);
    return !isSingleLineIf;
}

/**
 * Given a line that ends with `& _` or `+ _` and contains a string literal,
 * returns the column index of the opening `"` of that string.
 * Returns -1 if no string literal is found on the line.
 *
 * Example:
 *   `    stmt = "SELECT " & _`  →  11  (column of the first ")
 */
export function getStringAlignColumn(lineText: string): number {
    // Strip the trailing ` & _` / ` + _` so we search only the value part.
    const stripped = lineText.replace(/\s*[&+]\s*_\s*$/, '');
    const col = stripped.indexOf('"');
    return col; // -1 if no quote found
}
