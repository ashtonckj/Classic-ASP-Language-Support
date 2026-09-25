import * as vscode from 'vscode';
import { isInlineTag, isSelfClosingTag } from '../constants/htmlTags';
import { ASP_OBJECT_NAMES } from '../constants/aspKeywords';
import { getZone, Zone } from '../utils/zoneUtils';

// ── VBScript block keyword constants ───────────────────────────────────────

// Optional VBScript access modifiers that may precede Sub / Function / Property /
// Class (e.g. `Public Sub`, `Private Function`, `Public Default Property Get`).
// Without this the indenter ignored every access-modified declaration.
const MOD = '(?:(?:Public|Private|Default)\\s+)*';

// Pure openers: start a block, next line should be +1 indent. Property Get/Let/Set
// is a block just like Sub/Function.
const VBSCRIPT_BLOCK_OPENERS = new RegExp(
    '^' + MOD + '(If\\b.*Then|For\\b|For\\s+Each\\b|Do\\b|Do\\s+While\\b|Do\\s+Until\\b|While\\b|Sub\\b|Function\\b|Property\\b|With\\b|Select\\s+Case\\b|Class\\b)',
    'i',
);

// Pure closers: end a block, snap back to opener indent level
const VBSCRIPT_BLOCK_CLOSERS = /^(End\s+If\b|End\s+Sub\b|End\s+Function\b|End\s+Property\b|End\s+With\b|End\s+Select\b|End\s+Class\b|Next\b|Loop\b|Wend\b)/i;

// Mid-block keywords: close the block above AND open a new block below.
// On Enter they snap to their opener's indent level (+snapOffset), then give +1 on the next line.
// ElseIf/Else are peers of If  → snapOffset 0 (same indent as If)
// Case is subordinate to Select Case → snapOffset 1 (one level inside Select Case)
const VBSCRIPT_MID_BLOCK = /^(ElseIf\b|Else\b|Case\b)/i;

// Exact-match regex for auto-snap (onDidChangeTextDocument)
const VBSCRIPT_EXACT_CLOSER =
    /^(End\s+If|End\s+Sub|End\s+Function|End\s+Property|End\s+With|End\s+Select|End\s+Class|Next|Loop|Wend|ElseIf(?:\s+.*Then)?|Else|Case(?:\s+Else)?(?:\s+\S.*)?)$/i;

// Maps each closer/mid-block to its matching opener.
// snapOffset: how many extra indent levels to add on top of the opener's indent when snapping.
//   0 = align flush with opener (ElseIf/Else peers with If)
//   1 = one level inside opener (Case sits inside Select Case)
// family: links mid-block siblings so pure closers (End If) skip past them transparently.
const CLOSER_TO_OPENER: { closer: RegExp; opener: RegExp; isMidBlock?: boolean; snapOffset?: number; family?: string }[] = [
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
 * Removes a trailing VBScript comment ( ' … ) from a line, respecting string
 * literals ( "" escapes a quote ). Used when matching opener/closer keywords so
 * that `If b Then   ' note` is still recognised as an If opener.
 */
export function stripTrailingComment(line: string): string {
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (line[i + 1] === '"') { i++; continue; } // "" escaped quote
            inStr = !inStr;
        } else if (!inStr && ch === "'") {
            return line.slice(0, i);
        }
    }
    return line;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the indent unit string from editor options.
 * Shared by Enter and Tab handlers to avoid duplicating those 3 lines.
 */
function getIndentUnit(editor: vscode.TextEditor): string {
    const tabSize = editor.options.tabSize as number || 4;
    const useSpaces = editor.options.insertSpaces !== false;
    return useSpaces ? ' '.repeat(tabSize) : '\t';
}

// ── Line-continuation helpers ──────────────────────────────────────────────

/**
 * Returns true when the physical line ends with a VBScript line-continuation
 * marker (_ preceded by whitespace).  Strips inline comments before checking
 * so that a comment-only tail like  `someExpr And _  ' note`  still counts.
 */
function lineEndsContinuation(lineText: string): boolean {
    // Fast exit: if the line doesn't end with whitespace+_ at all, bail immediately.
    // This is true for the vast majority of lines and avoids the character loop entirely.
    if (!/\s_\s*$/.test(lineText)) { return false; }

    // The line LOOKS like it ends with _ — now verify the _ is not inside a string
    // literal or after a VBScript comment marker (').
    let inStr = false;
    let lastUnderscoreOutside = -1;
    for (let i = 0; i < lineText.length; i++) {
        const ch = lineText[i];
        if (inStr) {
            if (ch === '"') {
                if (i + 1 < lineText.length && lineText[i + 1] === '"') { i++; continue; }
                inStr = false;
            }
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "'") { break; } // rest of line is comment — stop here
        if (ch === '_') { lastUnderscoreOutside = i; }
    }

    if (lastUnderscoreOutside === -1) { return false; }
    // The _ must be preceded by whitespace (not part of an identifier)
    return lastUnderscoreOutside > 0 && /\s/.test(lineText[lastUnderscoreOutside - 1]);
}

/**
 * Given a physical line index `physLine`, walks backward to collect the full
 * logical line that ENDS at `physLine`.
 *
 * Returns:
 *   text      — joined logical text (continuation markers stripped)
 *   startLine — physical line index where the logical line begins
 *               (used to read the correct leading whitespace for indent snapping)
 *
 * Example — if lines 5, 6, 7 look like:
 *   5:  If (a And b) Or _
 *   6:     (c And d) Or _
 *   7:     (e And f) Then
 *
 * getLogicalLineEndingAt(doc, 7) returns:
 *   { text: "If (a And b) Or    (c And d) Or    (e And f) Then", startLine: 5 }
 */
function getLogicalLineEndingAt(
    document: vscode.TextDocument,
    physLine: number
): { text: string; startLine: number } {
    // Collect the chain by walking backward from physLine - 1 to find the start.
    // Blank lines between continuation lines are skipped — they are just formatting
    // whitespace and do not break the chain.  Only a non-blank line that does NOT
    // end with _ terminates the backward walk.
    const chainLines: string[] = [document.lineAt(physLine).text];
    let startLine = physLine;

    for (let i = physLine - 1; i >= 0; i--) {
        const t = document.lineAt(i).text;
        if (t.trim() === '') {
            continue; // blank line — skip, keep walking backward
        }
        if (lineEndsContinuation(t)) {
            chainLines.unshift(t);
            startLine = i;
        } else {
            break;
        }
    }

    // Strip the trailing ` _` from all but the last line and join,
    // filtering out any blank lines that were interspersed in the chain.
    const nonBlank = chainLines.filter(l => l.trim() !== '');
    const joined = nonBlank
        .map((l, idx) => idx < nonBlank.length - 1 ? l.replace(/\s_\s*$/, ' ') : l)
        .join('')
        .trim();

    return { text: joined, startLine };
}

/**
 * Scans upward to find the indent of the opener matching a given closer keyword.
 *
 * Handles three kinds of keywords:
 *   Pure closers  (End If, Next, …)   → scan up until matching opener found
 *   Mid-block     (ElseIf, Else, Case) → when they ARE the keyword being resolved,
 *                                         they snap to the same indent as their opener.
 *                                         When a pure closer (End If) scans past them
 *                                         they are transparent — depth is unchanged.
 *   Foreign blocks                     → tracked independently so nesting of a
 *                                         different block type doesn't confuse the scan.
 *
 * Line-continuation awareness: each physical line is first resolved into its full
 * logical line (via getLogicalLineEndingAt) before being classified.  This means
 * an If whose condition spans multiple physical lines is correctly recognised as an
 * opener even when the Then keyword is on the last continuation line.
 */
function findMatchingOpenerIndent(
    document: vscode.TextDocument,
    closerLineIndex: number,
    closerText: string,
    indentUnit: string = '    '
): string | null {
    const targetIdx = CLOSER_TO_OPENER.findIndex(p => p.closer.test(closerText));
    if (targetIdx === -1) { return null; }

    const targetEntry = CLOSER_TO_OPENER[targetIdx];
    const targetIsMid = !!targetEntry.isMidBlock;
    const snapOffset = targetEntry.snapOffset ?? 0;

    // All mid-block entries in the same family (ElseIf + Else, both family 'if').
    // When a pure closer (End If) scans past them they are transparent — depth unchanged.
    // When a mid-block is resolving itself, hitting a same-family sibling is a valid boundary.
    const familySiblingIndices = targetEntry.family
        ? CLOSER_TO_OPENER
            .map((p, i) => ({ p, i }))
            .filter(({ p, i }) => i !== targetIdx && p.isMidBlock && p.family === targetEntry.family)
            .map(({ i }) => i)
        : [];

    let targetDepth = 1;
    // Track unmatched pure closers of foreign block types so we don't miscount
    // openers that belong to a nested foreign block.
    const foreignDepth: number[] = CLOSER_TO_OPENER.map(() => 0);

    for (let i = closerLineIndex - 1; i >= 0; i--) {
        const rawLine = document.lineAt(i).text;
        let text: string;
        let startLine: number;

        // Check whether this line is part of a continuation chain.
        // A line is part of a chain if it ITSELF ends with _ (it's a mid/opener line),
        // OR if the line immediately above it ends with _ (it's the tail of a chain).
        // Both cases need getLogicalLineEndingAt to join the physical lines correctly.
        const prevLineEnds = i > 0 && lineEndsContinuation(document.lineAt(i - 1).text);

        if (lineEndsContinuation(rawLine) || prevLineEnds) {
            // Part of a continuation chain — resolve the full logical line.
            const resolved = getLogicalLineEndingAt(document, i);
            text = stripTrailingComment(resolved.text).trim();
            startLine = resolved.startLine;
            // Jump i past the earlier physical lines of this chain so the outer
            // loop doesn't re-process them.
            if (resolved.startLine < i) {
                i = resolved.startLine;
            }
        } else {
            // Fast path — plain line with no continuation involved. Strip a trailing
            // ' comment so `If b Then   ' note` still matches the If opener.
            text = stripTrailingComment(rawLine).trim();
            startLine = i;
        }

        if (!text) { continue; }

        // ── Closer-side check ──────────────────────────────────────────────
        const closerIdx = CLOSER_TO_OPENER.findIndex(p => p.closer.test(text));
        if (closerIdx !== -1) {
            if (closerIdx === targetIdx) {
                if (!foreignDepth.some(d => d > 0)) {
                    if (targetIsMid && targetDepth === 1) {
                        // Another same-type mid-block at depth 1 is our boundary.
                        // It's already at the correct indent — return it as-is, no snapOffset.
                        const m = document.lineAt(startLine).text.match(/^(\s*)/);
                        return m ? m[1] : '';
                    }
                    targetDepth++;
                }
            } else if (familySiblingIndices.includes(closerIdx)) {
                if (!foreignDepth.some(d => d > 0)) {
                    if (targetIsMid && targetDepth === 1) {
                        // Hit a family sibling (e.g. ElseIf hits Else).
                        // Sibling is already at the correct indent — return as-is, no snapOffset.
                        const m = document.lineAt(startLine).text.match(/^(\s*)/);
                        return m ? m[1] : '';
                    }
                    // Pure closer (End If) hits ElseIf/Else/Case → transparent, skip
                }
            } else {
                foreignDepth[closerIdx]++;
            }
            continue;
        }

        // ── Opener-side check ──────────────────────────────────────────────
        // Match directly against our target's own opener pattern — NOT via findIndex,
        // because findIndex returns the wrong entry when multiple entries share an opener
        // (e.g. "If condition Then" matches both End-If's opener AND ElseIf's opener).
        if (targetEntry.opener.test(text)) {
            if (!foreignDepth.some(d => d > 0)) {
                targetDepth--;
                if (targetDepth === 0) {
                    // Use startLine for indent — that's where the If/For/etc. keyword is
                    const m = document.lineAt(startLine).text.match(/^(\s*)/);
                    const base = m ? m[1] : '';
                    return base + indentUnit.repeat(snapOffset);
                }
            }
            continue;
        }

        // Check if this line is a pure opener for a foreign block type so we can
        // balance its corresponding closer we may have counted above.
        for (let j = 0; j < CLOSER_TO_OPENER.length; j++) {
            if (j === targetIdx || familySiblingIndices.includes(j)) { continue; }
            if (CLOSER_TO_OPENER[j].opener.test(text)) {
                if (foreignDepth[j] > 0) { foreignDepth[j]--; }
                break;
            }
        }
    }

    return null;
}

/**
 * Scans upward from closerLineIndex to find the indent of the matching <%
 * for a standalone %> line. Tracks nesting so inner <%...%> pairs are skipped.
 */
function findAspOpenerIndent(document: vscode.TextDocument, closerLineIndex: number): string | null {
    let depth = 1;
    for (let i = closerLineIndex - 1; i >= 0; i--) {
        const text = document.lineAt(i).text.trim();
        if (!text) { continue; }
        // A line that closes an ASP block (without also opening one) increases depth
        if (/^%>$/.test(text) || (/^(?!<%).*%>$/.test(text))) {
            depth++;
        } else if (text.startsWith('<%')) {
            depth--;
            if (depth === 0) {
                const m = document.lineAt(i).text.match(/^(\s*)/);
                return m ? m[1] : '';
            }
        }
    }
    return null;
}

/**
 * Scans upward from startLine to find the indent of the nearest unclosed
 * HTML block-level opener tag (skipping self-closing and inline tags).
 * Returns openerIndent + indentUnit — the correct child indent level.
 * Returns null when at document root (no enclosing HTML block tag found).
 *
 * Properly tracks closing tag depth so </ul> cancels its own <ul>, and
 * skips <%...%> fragments entirely so VBScript lines don't confuse the scan.
 */
function findEnclosingHtmlChildIndent(
    document: vscode.TextDocument,
    startLine: number,
    indentUnit: string
): string | null {
    let aspDepth  = 0;
    // closedTags[tag] counts how many closing tags of that name we've passed
    // without yet seeing their opener — those openers must be skipped.
    const closedTags: Record<string, number> = {};

    for (let i = startLine - 1; i >= 0; i--) {
        const raw  = document.lineAt(i).text;
        const text = raw.trim();
        if (!text) { continue; }

        // Skip ASP fragment content (scan backwards: %> raises depth, <% lowers it)
        if (text.startsWith('%>') || (text.endsWith('%>') && !text.startsWith('<%'))) {
            aspDepth++;
            continue;
        }
        if (text.startsWith('<%')) {
            if (aspDepth > 0) { aspDepth--; }
            continue;
        }
        if (aspDepth > 0) { continue; }

        // Closing HTML tag — record it so its matching opener is skipped
        const closingMatch = text.match(/^<\/(\w+)/i);
        if (closingMatch) {
            const tag = closingMatch[1].toLowerCase();
            closedTags[tag] = (closedTags[tag] ?? 0) + 1;
            continue;
        }

        // Opening HTML tag — check whether it is the enclosing parent
        // The regex requires the tag is NOT self-closed on the same line (e.g. <div></div>)
        const openingMatch = text.match(/^<(\w+)(\s[^>]*)?>(?!.*<\/\1\s*>)/i);
        if (openingMatch) {
            const tag = openingMatch[1].toLowerCase();
            if (isInlineTag(tag) || isSelfClosingTag(tag)) { continue; }
            // If we've already seen a closer for this tag, it cancels this opener
            if (closedTags[tag] && closedTags[tag] > 0) {
                closedTags[tag]--;
                continue;
            }
            // This is an unmatched opener — it's our enclosing parent
            const m = raw.match(/^(\s*)/);
            return (m ? m[1] : '') + indentUnit;
        }
    }
    return null;
}


// ── Line-continuation patterns that mean a trailing _ is NOT an identifier ──
// Each pattern matches the text BEFORE the _ on the line (trimmed).
// If any matches, the _ is a line continuation and suggestions must be hidden.
const LINE_CONTINUATION_BEFORE_PATTERNS: RegExp[] = [
    // Assignment:  something =  _
    /=\s*$/,
    // Concatenation operator:  & _   or  + _
    /[&+]\s*$/,
    // Comparison / logical operators:  <> _ , <= _ , >= _ , = _ , And _ , Or _ , Not _
    /(?:<=|>=|<>|<|>|=|And|Or|Not|Xor|Eqv|Imp)\s*$/i,
    // Arithmetic operators:  * _  / _  \ _  Mod _  ^ _  - _
    /(?:\*|\/|\\|Mod|\^|-)\s*$/i,
    // Open paren (argument list continues):  SomeFunc( _
    /\(\s*$/,
    // Comma (argument or array element continues):  arg1, _
    /,\s*$/,
    // After a closing paren/bracket (chained call):  ) _   or  ] _
    /[)\]]\s*$/,
    // Keyword that expects a value to follow:  Then _  Else _  Return _  Call _
    /(?:Then|Else|ElseIf|Return|Call|Set|Let|ReDim|Dim|Private|Public|Const)\s*$/i,
];

/**
 * Returns true when the trailing _ on the given line is a VBScript
 * line-continuation character rather than part of an identifier.
 *
 * Rules:
 *   1. The _ must be preceded by at least one whitespace character
 *      (a bare  _name  at the start of a word is always an identifier).
 *   2. The text before the _ (trimmed) must match at least one of the
 *      known line-continuation context patterns above.
 */
function isLineContinuation(lineTextUpToCursor: string): boolean {
    // Must have whitespace immediately before the trailing _
    if (!/\s_\s*$/.test(lineTextUpToCursor)) { return false; }

    const beforeUnderscore = lineTextUpToCursor.replace(/\s_\s*$/, '').trimEnd();

    // A line that is ONLY _ (or indented _) with nothing before it:
    // e.g. the user is on a blank line and typed _ — treat as continuation.
    if (beforeUnderscore.trim() === '') { return true; }

    return LINE_CONTINUATION_BEFORE_PATTERNS.some(p => p.test(beforeUnderscore));
}

// ── String-continuation alignment helpers ─────────────────────────────────

/**
 * Given a line that ends with `& _` or `+ _` and contains a string literal,
 * returns the column index of the opening `"` of that string.
 * Returns -1 if no string literal is found on the line.
 *
 * Example:
 *   `    stmt = "SELECT " & _`  →  11  (column of the first ")
 */
function getStringAlignColumn(lineText: string): number {
    // Strip the trailing ` & _` / ` + _` so we search only the value part.
    const stripped = lineText.replace(/\s*[&+]\s*_\s*$/, '');
    const col = stripped.indexOf('"');
    return col; // -1 if no quote found
}

/**
 * Scans upward from `fromLine` (exclusive) to find the first line of a
 * VBScript line-continuation chain — i.e. the line whose previous line does
 * NOT end with `_`.  Returns that line's leading whitespace (base indent).
 *
 * If the scan reaches the top of the document without finding a non-continuation
 * predecessor, it returns the indent of the topmost line examined.
 */
function findContinuationChainBaseIndent(
    document: vscode.TextDocument,
    fromLine: number,
): string {
    // Walk upward. The chain looks like:
    //   anotherlongstmt = "..." & _   <- opener (no _ on the line BEFORE it)
    //                     "..." & _   <- mid-chain continuation
    //                     "..."       <- fromLine (last line, no _)
    //
    // Skip fromLine itself (no _), then skip every line that DOES end with _,
    // and return the indent of the first line that does NOT end with _ — that
    // is the statement opener.
    let skippedFromLine = false;
    let lastChainLineIndent = document.lineAt(fromLine).text.match(/^(\s*)/)?.[1] ?? '';
    for (let i = fromLine; i >= 0; i--) {
        const text = document.lineAt(i).text;
        // Blank line = statement boundary — the previous chain line is the opener.
        if (!text.trim()) { return lastChainLineIndent; }
        const isContinuation = /(?:^|\s)_\s*$/.test(text.trim());
        if (!skippedFromLine) {
            skippedFromLine = true; // fromLine itself — skip it
            continue;
        }
        if (!isContinuation) {
            return text.match(/^(\s*)/)?.[1] ?? ''; // statement opener
        }
        // Line ends with _ — mid-chain continuation, record its indent and keep going
        lastChainLineIndent = text.match(/^(\s*)/)?.[1] ?? '';
    }
    return lastChainLineIndent;
}

// ── Suppress suggestions on line-continuation _ ───────────────────────────
// onDidChangeTextDocument fires synchronously after every edit, before VS Code
// has a chance to show the (stale) cached completion list.  If the typed char
// is _ and the line context says it's a continuation, we immediately call
// hideSuggestWidget so the popup never appears.

export function registerLineContinuationGuard(context: vscode.ExtensionContext) {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) { return; }
        if (event.document.languageId !== 'asp')           { return; }
        if (event.contentChanges.length === 0)             { return; }

        const change = event.contentChanges[0];

        // Only care when the character typed was _
        if (change.text !== '_') { return; }

        const lineNo    = change.range.start.line;
        const line      = event.document.lineAt(lineNo);
        // Text up to and including the newly typed _
        const lineUpTo  = line.text.substring(0, change.range.start.character + 1);

        if (isLineContinuation(lineUpTo)) {
            // Hide the suggestion widget. We fire twice — once immediately
            // (catches the cached list) and once after a short delay (catches
            // the freshly-invoked list that VS Code may show after the edit).
            vscode.commands.executeCommand('hideSuggestWidget');
            setTimeout(() => vscode.commands.executeCommand('hideSuggestWidget'), 50);
        }
    });

    context.subscriptions.push(disposable);
}

// ── Auto-closing tag + auto-snap VBScript closers ──────────────────────────

/**
 * Decides whether a `>` just typed should be followed by an auto-inserted
 * closing tag, and for which element. Returns null when it should not.
 *
 * `textBefore` is the line up to (not including) the typed `>`. `zoneAt` is
 * called only if every cheaper check passes, so callers can defer the
 * whole-document scan it needs.
 *
 * Bails when:
 *   • the `>` sits inside a quoted attribute value — `<a href="<>">` closes the
 *     inner `<`, not the tag;
 *   • the user typed `/>` themselves — `<div />` needs nothing appended;
 *   • there is no `<tag` immediately before the caret, or it is a void element;
 *   • the caret is not in markup. This last one is what keeps
 *     `Response.Write "<div>"` — the ordinary way to emit HTML in Classic ASP —
 *     from getting `</div>` injected into the middle of the string. The
 *     attribute-value guard cannot catch it: that guard only arms once a tag
 *     opener has been seen on the line, and inside a VBScript string there is
 *     none. Same for `document.write("<div>")` in a <script>.
 */
export function tagToAutoClose(textBefore: string, zoneAt: () => Zone): string | null {
    let inQuote: string | null = null;
    let lastRealTagOpen = -1;
    for (let i = 0; i < textBefore.length; i++) {
        const ch = textBefore[i];
        if (inQuote) {
            if (ch === inQuote) { inQuote = null; }
        } else {
            if (ch === '"' || ch === "'") { inQuote = ch; }
            else if (ch === '<') {
                const next = textBefore[i + 1];
                if (next && /[a-zA-Z/!]/.test(next)) {
                    lastRealTagOpen = i;
                    inQuote = null;
                }
            }
        }
    }
    if (lastRealTagOpen !== -1 && inQuote !== null) { return null; }

    if (/\/\s*$/.test(textBefore)) { return null; }

    const tagMatch = textBefore.match(/<(\w+)(?:\s+[^>]*)?$/);
    if (!tagMatch || isSelfClosingTag(tagMatch[1])) { return null; }

    if (zoneAt() !== 'html') { return null; }

    return tagMatch[1];
}

// ── Multi-cursor position bookkeeping ──────────────────────────────────────
//
// onDidChangeTextDocument reports each change's range in PRE-edit coordinates,
// while event.document is already POST-edit. With one cursor the two agree; with
// several cursors on one line each insertion shifts the ones after it, so the
// pre-edit column of the second `>` on a line is one short of where it now sits.

/** One place a character was just typed, and what should be auto-inserted there. */
export interface AutoInsertSite {
    line: number;
    /** Column just after the typed character — where the insertion goes. */
    at: number;
    /** Text to insert, or undefined to leave this cursor alone. */
    insert?: string;
    /** How far into `insert` the caret belongs (0 = before it). */
    caretOffset: number;
}

/**
 * Post-edit position of each typed character, given the pre-edit change positions.
 * Returns one entry per change, ascending by position.
 */
export function typedCharPositions(
    changes: readonly { line: number; character: number }[],
): { line: number; character: number }[] {
    const ascending = [...changes].sort(
        (a, b) => (a.line !== b.line ? a.line - b.line : a.character - b.character),
    );

    const seenOnLine = new Map<number, number>();
    return ascending.map(({ line, character }) => {
        const shift = seenOnLine.get(line) ?? 0;
        seenOnLine.set(line, shift + 1);
        return { line, character: character + shift };
    });
}

/**
 * Where every caret must end up once a batch of insertions has been applied.
 *
 * All positions handed to one TextEditorEdit are read against the document as it
 * was when the edit began, so the caller does not pre-shift them — but the caret
 * positions do have to account for each insertion made earlier on the same line.
 * An insertion at exactly a caret's own column pushes the text after it right and
 * leaves that column alone, so only strictly-earlier insertions count.
 *
 * Sites with no `insert` are included too: they are the other cursors, and they
 * have to be handed back or assigning editor.selections would delete them.
 */
export function caretsAfterInserts(
    sites: readonly AutoInsertSite[],
): { line: number; character: number }[] {
    const ascending = [...sites].sort(
        (a, b) => (a.line !== b.line ? a.line - b.line : a.at - b.at),
    );

    const insertedOnLine = new Map<number, number>();
    return ascending.map(site => {
        const before = insertedOnLine.get(site.line) ?? 0;
        if (site.insert) {
            insertedOnLine.set(site.line, before + site.insert.length);
        }
        return {
            line:      site.line,
            character: site.at + before + (site.insert ? site.caretOffset : 0),
        };
    });
}

export function registerAutoClosingTag(context: vscode.ExtensionContext) {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) { return; }
        if (event.document.languageId !== 'asp')           { return; }
        if (event.contentChanges.length === 0)             { return; }

        const changes = event.contentChanges;
        const typed   = changes[0].text;

        // getText() is only paid for once a cheap text check has already passed —
        // an ordinary keystroke must not allocate the whole document.
        let cachedText: string | undefined;
        const fullText = () => (cachedText ??= event.document.getText());

        // True when EVERY cursor typed the same single character over an empty
        // selection. Anything else is a paste, a snippet, or a mixed edit, and none
        // of the handlers below apply to it.
        const everyCursorTyped = (ch: string) =>
            changes.every(c => c.text === ch && c.rangeLength === 0);

        const zoneAtPosition = (line: number, character: number) =>
            getZone(fullText(), event.document.offsetAt(new vscode.Position(line, character)));

        // Applies the auto-insertions and puts every caret back.
        //
        // VS Code pushes a caret to the END of text inserted at its own position,
        // so each one is restored explicitly. Cursors that got no insertion are
        // restored too — assigning editor.selections replaces the whole set, and
        // leaving them out is what used to collapse a multi-cursor down to one.
        const applyAutoInserts = (sites: AutoInsertSite[]) => {
            if (!sites.some(site => site.insert)) { return; }

            const carets = caretsAfterInserts(sites);
            editor.edit(eb => {
                for (const site of sites) {
                    if (site.insert) {
                        eb.insert(new vscode.Position(site.line, site.at), site.insert);
                    }
                }
            }).then(() => {
                editor.selections = carets.map(caret => {
                    const p = new vscode.Position(caret.line, caret.character);
                    return new vscode.Selection(p, p);
                });
            });
        };

        // ---- HTML comment auto-close: <!-- → <!-- | -->
        if (typed === '-') {
            if (!everyCursorTyped('-')) { return; }

            const sites: AutoInsertSite[] = [];
            for (const { line, character } of typedCharPositions(changes.map(c => c.range.start))) {
                const site: AutoInsertSite = { line, at: character + 1, caretOffset: 1 };
                sites.push(site);

                if (character < 3) { continue; }
                const lineText = event.document.lineAt(line).text;
                if (!lineText.substring(0, character + 1).endsWith('<!--')) { continue; }
                // HTML comments are not valid inside a VBScript block.
                if (zoneAtPosition(line, character) === 'asp') { continue; }
                if (lineText.substring(character + 1).trim().startsWith('-->')) { continue; }

                site.insert = '  -->';
            }
            applyAutoInserts(sites);
            return;
        }

        // ---- HTML tag auto-close: <div> → <div></div>
        if (typed === '>') {
            if (!everyCursorTyped('>')) { return; }

            const sites: AutoInsertSite[] = [];
            for (const { line, character } of typedCharPositions(changes.map(c => c.range.start))) {
                const site: AutoInsertSite = { line, at: character + 1, caretOffset: 0 };
                sites.push(site);

                const lineText = event.document.lineAt(line).text;
                // The zone is only consulted once the cheap text checks inside
                // tagToAutoClose have passed.
                const tagName = tagToAutoClose(
                    lineText.substring(0, character),
                    () => zoneAtPosition(line, character),
                );
                if (!tagName) { continue; }

                const expectedClosing = `</${tagName}>`;
                if (lineText.substring(character + 1).trim().startsWith(expectedClosing)) { continue; }

                site.insert = expectedClosing;
            }
            applyAutoInserts(sites);
            return;
        }

        // ---- Auto-snap VBScript closer to correct indent when fully typed
        // Skip deletions and whitespace-only changes (Tab/Shift+Tab)
        if (changes.some(c => c.text === '' || !/\S/.test(c.text))) { return; }

        const snapIndentUnit = getIndentUnit(editor);
        const snaps: { line: number; fromLength: number; indent: string }[] = [];
        const snappedLines = new Set<number>();

        for (const change of changes) {
            const changeLine = change.range.start.line;
            // Two cursors on one line describe one line to snap, not two.
            if (snappedLines.has(changeLine)) { continue; }
            snappedLines.add(changeLine);

            const currentLine    = event.document.lineAt(changeLine);
            const currentTrimmed = currentLine.text.trim();
            const currentIndent  = currentLine.text.match(/^(\s*)/)?.[1] ?? '';

            // Snap standalone %> to its matching <% indent
            if (currentTrimmed === '%>') {
                const aspOpenerIndent = findAspOpenerIndent(event.document, changeLine);
                if (aspOpenerIndent !== null && aspOpenerIndent !== currentIndent) {
                    snaps.push({ line: changeLine, fromLength: currentIndent.length, indent: aspOpenerIndent });
                }
                continue;
            }

            if (!VBSCRIPT_EXACT_CLOSER.test(currentTrimmed)) { continue; }

            // The zone probe only runs for a line that already matches
            // VBSCRIPT_EXACT_CLOSER, so ordinary keystrokes never reach it.
            if (zoneAtPosition(changeLine, currentLine.text.length) !== 'asp') { continue; }

            const openerIndent = findMatchingOpenerIndent(event.document, changeLine, currentTrimmed, snapIndentUnit);
            if (openerIndent === null || openerIndent === currentIndent) { continue; }

            snaps.push({ line: changeLine, fromLength: currentIndent.length, indent: openerIndent });
        }

        if (snaps.length === 0) { return; }

        // Only the leading whitespace is replaced; VS Code shifts the carets with
        // the content. We deliberately do NOT reposition them ourselves — the old
        // async `.then(set selection)` raced the user's next keystrokes and
        // scrambled fast typing.
        editor.edit(eb => {
            for (const snap of snaps) {
                eb.replace(
                    new vscode.Range(
                        new vscode.Position(snap.line, 0),
                        new vscode.Position(snap.line, snap.fromLength),
                    ),
                    snap.indent,
                );
            }
        });
    });

    context.subscriptions.push(disposable);
}

// ── Enter key handler ──────────────────────────────────────────────────────

// A continuation line inside a JSDoc block: optional indent, then a star,
// then anything.
const JSDOC_CONTINUATION_LINE = /^\s*\*(\s.*)?$/;

// True when `previousLineText` is the kind of line a JSDoc continuation can
// follow — the block's opener, or an earlier star-prefixed line — and that
// line has not also closed the comment already.
//
// Deliberately line-local rather than a real scan for the matching opener:
// this is the same shape VS Code's own built-in onEnterRules use for every
// other language's block comments (checking only the current and previous
// line, not tokenizing the whole file), which keeps a rare misfire — some
// line that merely starts with a star, coincidentally, right below an
// unrelated comment — a cosmetic one-off rather than a reason to lex the
// surrounding code.
export function continuesOpenJsDocComment(previousLineText: string): boolean {
    if (/\*\/\s*$/.test(previousLineText)) { return false; } // already closed on that line
    return /^\s*(\/\*\*|\*)/.test(previousLineText);
}

export function registerEnterKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertLineBreak', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('default:type', { text: '\n' });
        }

        // Multi-cursor: the smart single-cursor logic below edits and re-positions
        // one cursor at a time, so it can't safely serve N cursors. Defer to VS
        // Code's native newline, which inserts and indents at every cursor.
        if (editor.selections.length > 1) {
            return vscode.commands.executeCommand('default:type', { text: '\n' });
        }

        const position        = editor.selection.active;
        const document        = editor.document;
        const fullText        = document.getText();
        const line            = document.lineAt(position.line);
        const textBefore      = line.text.substring(0, position.character);
        const textAfter       = line.text.substring(position.character);
        const currentLineText = textBefore.trim();
        const indent          = textBefore.match(/^(\s*)/)?.[0] || '';
        const indentUnit      = getIndentUnit(editor);

        // When nothing meaningful precedes the cursor (column 0, or only whitespace),
        // none of the smart-indent branches below apply — they key off what was typed
        // before the cursor. Maintain the current indent on the new line, like a
        // plain editor. `indent` is textBefore's leading whitespace, so:
        //   • at column 0 it's empty → a plain newline (any spaces/content after the
        //     cursor are preserved, cursor lands at column 0);
        //   • after some indentation it carries that indent → content or a `}`
        //     following the cursor lands at the correct column instead of column 0.
        if (currentLineText === '') {
            editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
                const p = new vscode.Position(position.line + 1, indent.length);
                editor.selection = new vscode.Selection(p, p);
            });
            return;
        }

        const zone = getZone(fullText, document.offsetAt(position));

        // ── JSDoc continuation ───────────────────────────────────────────
        // A plain .js file gets this from the TypeScript extension's own
        // onEnterRules; a <script> block in an ASP page has no such rules of
        // its own, so `/**` + Enter just left a bare newline at the same
        // indent, and pressing Enter on a `* ...` line did not continue the
        // star column either.
        if (zone === 'js') {
            // Starting a brand-new block: the line up to the cursor is exactly
            // `/**`, with nothing else before it.
            if (textBefore.trim() === '/**') {
                const rest = textAfter.trim();
                if (rest === '' || rest === '*/') {
                    // `/**|` or `/**|*/` — either way, expand to the standard
                    // three-line skeleton and drop the caret on the middle line.
                    editor.edit(eb => {
                        eb.replace(
                            new vscode.Range(position, new vscode.Position(position.line, line.text.length)),
                            `\n${indent} * \n${indent} */`,
                        );
                    }).then(() => {
                        const p = new vscode.Position(position.line + 1, indent.length + 3);
                        editor.selection = new vscode.Selection(p, p);
                    });
                    return;
                }
            }

            // Continuing an existing block: the line up to the cursor is just
            // `*` (optionally followed by more text), and the line above is
            // part of the same, still-open comment.
            if (JSDOC_CONTINUATION_LINE.test(textBefore) && position.line > 0
                && continuesOpenJsDocComment(document.lineAt(position.line - 1).text)) {
                editor.edit(eb => eb.insert(position, `\n${indent}* `)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + 2);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }
        }

        // ── JS / CSS brace handling ─────────────────────────────────────
        // Pressing Enter right after `{` should open an indented block, matching a
        // real .js/.css file. When a `}` immediately follows the cursor (`{|}` —
        // typically because the editor auto-closed the brace) expand to three lines
        // with the `}` on its own line; otherwise just add one indent level. Without
        // this the fall-through kept the current indent, leaving `}` glued to the
        // cursor with no indentation.
        if ((zone === 'js' || zone === 'css') && textBefore.trimEnd().endsWith('{')) {
            const rest = textAfter.trimStart();
            if (rest.startsWith('}')) {
                editor.edit(eb => {
                    eb.replace(
                        new vscode.Range(position, new vscode.Position(position.line, line.text.length)),
                        `\n${indent}${indentUnit}\n${indent}${rest}`,
                    );
                }).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
            } else {
                editor.edit(eb => eb.insert(position, `\n${indent}${indentUnit}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
            }
            return;
        }

        // ── ASP / VBScript block handling ───────────────────────────────

        // Expand <%|%> on Enter.
        // VBScript code sits at the same indent as <% itself — no extra level.
        // <% and %> are at HTML child level; code between them is at that same level.
        if (/^<%=?\s*$/.test(textBefore.trim()) && textAfter.trimEnd() === '%>') {
            editor.edit(eb => {
                eb.replace(
                    new vscode.Range(position, new vscode.Position(position.line, line.text.length)),
                    `\n${indent}\n${indent}%>`
                );
            }).then(() => {
                const p = new vscode.Position(position.line + 1, indent.length);
                editor.selection = new vscode.Selection(p, p);
            });
            return;
        }

        // Standalone %> on Enter:
        //   1. Snap %> to its matching <% indent (if misaligned).
        //   2. The newline after %> re-enters HTML context — use the enclosing
        //      HTML opener's child indent so the next <li> etc. lands correctly.
        //      Falls back to targetIndent (same as %>) if no HTML opener is found.
        if (currentLineText === '%>') {
            const aspOpenerIndent  = findAspOpenerIndent(document, position.line);
            const targetIndent     = aspOpenerIndent !== null ? aspOpenerIndent : indent;
            // After %>, we're back in HTML — find what indent the next HTML child should use
            const htmlChildIndent  = findEnclosingHtmlChildIndent(document, position.line, indentUnit)
                                    ?? targetIndent;
            if (targetIndent !== indent) {
                const lineEnd = new vscode.Position(position.line, indent.length + currentLineText.length);
                editor.edit(eb => {
                    eb.replace(
                        new vscode.Range(new vscode.Position(position.line, 0), lineEnd),
                        `${targetIndent}${currentLineText}\n${htmlChildIndent}`
                    );
                }).then(() => {
                    const p = new vscode.Position(position.line + 1, htmlChildIndent.length);
                    editor.selection = new vscode.Selection(p, p);
                });
            } else {
                editor.edit(eb => eb.insert(position, `\n${htmlChildIndent}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, htmlChildIndent.length);
                    editor.selection = new vscode.Selection(p, p);
                });
            }
            return;
        }

        if (zone === 'asp') {

            // After <% or <%= on its own line: VBScript code sits at the same indent
            // as <% itself — no extra level added. <% is at HTML child level and
            // VBScript lines sit flush with it.
            if (/^<%=?$/.test(currentLineText)) {
                editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }

            // Mid-block keyword (ElseIf, Else, Case, Case Else):
            // Snap the current line to its opener's indent level, then give +1 on next line.
            // Always use openerIndent as the base for the next line — even if the current line
            // failed to snap (e.g. typed without triggering auto-snap), so the body indent is
            // always openerIndent + 1 regardless of where the mid-block line physically sits.
            if (VBSCRIPT_MID_BLOCK.test(currentLineText)) {
                const openerIndent = findMatchingOpenerIndent(document, position.line, currentLineText, indentUnit);
                const targetIndent = openerIndent !== null ? openerIndent : indent;
                const bodyIndent   = targetIndent + indentUnit;

                if (targetIndent !== indent) {
                    // Current line is at the wrong indent — fix it and set cursor
                    const lineEnd = new vscode.Position(position.line, indent.length + currentLineText.length);
                    editor.edit(eb => {
                        eb.replace(
                            new vscode.Range(new vscode.Position(position.line, 0), lineEnd),
                            `${targetIndent}${currentLineText}\n${bodyIndent}`
                        );
                    }).then(() => {
                        const p = new vscode.Position(position.line + 1, bodyIndent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                } else {
                    editor.edit(eb => eb.insert(position, `\n${bodyIndent}`)).then(() => {
                        const p = new vscode.Position(position.line + 1, bodyIndent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
                return;
            }

            // Pure block closer (End If, Next, Loop, Wend, …):
            // Snap current line to opener indent, newline at same level.
            if (VBSCRIPT_BLOCK_CLOSERS.test(currentLineText)) {
                const openerIndent = findMatchingOpenerIndent(document, position.line, currentLineText, indentUnit);
                const targetIndent = openerIndent !== null ? openerIndent : indent;

                if (targetIndent !== indent) {
                    const lineEnd = new vscode.Position(position.line, indent.length + currentLineText.length);
                    editor.edit(eb => {
                        eb.replace(
                            new vscode.Range(new vscode.Position(position.line, 0), lineEnd),
                            `${targetIndent}${currentLineText}\n${targetIndent}`
                        );
                    }).then(() => {
                        const p = new vscode.Position(position.line + 1, targetIndent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                } else {
                    editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
                        const p = new vscode.Position(position.line + 1, indent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
                return;
            }

            // ── Line continuation (_) ────────────────────────────────────
            //
            // When the current line ends with `& _` or `+ _` we try to align
            // the next line to the opening `"` of the string on THIS line.
            //
            // Three sub-cases:
            //   A. Current line has a string literal → align to its `"` column.
            //   B. Current line has no string (e.g. bare `& _`) but a previous
            //      continuation line established a column → stay at that column
            //      (detected because `indent` already equals that column's spaces).
            //   C. No string anywhere in the chain → fall back to indent+indentUnit.
            //
            // When the current line does NOT end with `_` but the previous line
            // DID (i.e. we are on the last line of a continuation chain), snap
            // back to the base-statement indent so the next statement starts
            // at the correct column.
            if (/(?:^|\s)_\s*$/.test(currentLineText)) {
                // Lines ending with & _ or + _ (string concatenation continuation)
                const isStringConcat = /[&+]\s*_\s*$/.test(currentLineText);
                if (isStringConcat) {
                    const col = getStringAlignColumn(line.text);
                    if (col >= 0) {
                        // Case A: align to the `"` on this line.
                        const alignIndent = ' '.repeat(col);
                        editor.edit(eb => eb.insert(position, '\n' + alignIndent)).then(() => {
                            const p = new vscode.Position(position.line + 1, col);
                            editor.selection = new vscode.Selection(p, p);
                        });
                    } else {
                        // Case B/C: no string on this line — keep current column.
                        editor.edit(eb => eb.insert(position, '\n' + indent)).then(() => {
                            const p = new vscode.Position(position.line + 1, indent.length);
                            editor.selection = new vscode.Selection(p, p);
                        });
                    }
                } else {
                    // Non-string continuation (e.g. arithmetic / assignment split):
                    // give +1 indent level as before.
                    editor.edit(eb => eb.insert(position, '\n' + indent + indentUnit)).then(() => {
                        const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
                return;
            }

            // ── Snap back after last continuation line ───────────────────
            // If the line above this one ended with `_`, we are on the final
            // line of a continuation chain. On Enter, snap back to the indent
            // of the statement that started the chain (scan up past all `_` lines).
            {
                let prevNonEmpty = '';
                for (let i = position.line - 1; i >= 0; i--) {
                    const t = document.lineAt(i).text;
                    if (t.trim()) { prevNonEmpty = t; break; }
                }
                if (/(?:^|\s)_\s*$/.test(prevNonEmpty.trim())) {
                    const baseIndent = findContinuationChainBaseIndent(document, position.line);
                    editor.edit(eb => eb.insert(position, '\n' + baseIndent)).then(() => {
                        const p = new vscode.Position(position.line + 1, baseIndent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                    return;
                }
            }

            // Block opener → next line +1. isBlockOpener excludes a single-line
            // `If … Then <statement>` (which opens nothing) and now also matches
            // access-modified and Property declarations.
            if (isBlockOpener(currentLineText)) {
                editor.edit(eb => eb.insert(position, `\n${indent}${indentUnit}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }

            // Default inside ASP → match current indent
            editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
                const p = new vscode.Position(position.line + 1, indent.length);
                editor.selection = new vscode.Selection(p, p);
            });
            return;
        }

        // ── HTML context handling ───────────────────────────────────────

        // HTML comment: <!-- | -->
        if (textBefore.trim().endsWith('<!--') && textAfter.trim().startsWith('-->')) {
            editor.edit(eb => {
                eb.replace(new vscode.Range(position, line.range.end),
                    `\n${indent}${indentUnit}\n${indent}-->`);
            }).then(() => {
                const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                editor.selection = new vscode.Selection(p, p);
            });
            return;
        }

        // Closed tag: <div>|</div>  or  <div>| with closing tag elsewhere
        const justClosedTagMatch = textBefore.match(/<(\w+)([^>]*)>$/);
        if (justClosedTagMatch) {
            const tagName = justClosedTagMatch[1];

            if (!isSelfClosingTag(tagName)) {
                const closingTag      = `</${tagName}>`;
                const closingTagRegex = new RegExp(`</${tagName}>`, 'i');
                // Only getText from cursor to end — avoids scanning the whole document
                const afterCursorText = document.getText(
                    new vscode.Range(position, document.lineAt(document.lineCount - 1).range.end)
                );

                if (closingTagRegex.test(afterCursorText)) {
                    if (textAfter.trim().startsWith(closingTag)) {
                        // <div>|</div> → expand
                        editor.edit(eb => {
                            eb.replace(new vscode.Range(position, line.range.end),
                                `\n${indent}${indentUnit}\n${indent}${closingTag}`);
                        }).then(() => {
                            const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                            editor.selection = new vscode.Selection(p, p);
                        });
                    } else {
                        editor.edit(eb => eb.insert(position, `\n${indent}${indentUnit}`)).then(() => {
                            const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                            editor.selection = new vscode.Selection(p, p);
                        });
                    }
                    return;
                }

                // No closing tag — create it
                editor.edit(eb => eb.insert(position, `\n${indent}${indentUnit}\n${indent}${closingTag}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }
        }

        // Incomplete tag: <div|
        const incompleteTagMatch = textBefore.match(/<(\w+)([^>]*)$/);
        if (incompleteTagMatch && !textBefore.endsWith('>')) {
            const tagName = incompleteTagMatch[1];
            if (!isSelfClosingTag(tagName)) {
                const closingTag = `</${tagName}>`;
                editor.edit(eb => eb.insert(position, `>\n${indent}${indentUnit}\n${indent}${closingTag}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }
        }

        // Default HTML newline — maintain the current indent. The col-0 and
        // whitespace-only cases already returned to the native newline above, so
        // here the cursor is always past the line's leading whitespace.
        editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
            const p = new vscode.Position(position.line + 1, indent.length);
            editor.selection = new vscode.Selection(p, p);
        });
        return;
    });

    context.subscriptions.push(disposable);
}

// ── Tab key handler ────────────────────────────────────────────────────────

/**
 * Tokens that are unmistakably an Emmet abbreviation rather than prose.
 *
 * `>` `+` `^` `*` are Emmet's structural operators (child, sibling, climb,
 * multiply) and do not otherwise appear inside a word; the second form is the
 * class/id shorthand, anchored so the WHOLE token has to look like one.
 *
 * This is what makes expanding on Tab safe without the global setting. VS Code
 * turns `emmet.triggerExpansionOnTab` off by default because with it on, any
 * word plus Tab expands — typing `Total` in body text and reaching for Tab gives
 * `<Total></Total>`, and an ASP page is mostly body text. Requiring one of these
 * markers keeps `ul>li*3` and `div.row` working while leaving a plain word alone.
 */
const ABBREVIATION_OPERATORS = /[>+^*]/;
const ABBREVIATION_SHORTHAND = /^(?:[A-Za-z][\w-]*)?(?:[.#][\w-]+)+$/;

/** The run of non-whitespace immediately before the caret. */
function tokenBefore(lineText: string, character: number): string {
    const upToCaret = lineText.slice(0, character);
    return upToCaret.slice(upToCaret.search(/\S*$/));
}

/**
 * True when the text before the caret is worth handing to Emmet even though the
 * user has not turned on expansion for every word.
 *
 * This only decides whether a word in an HTML or CSS zone is worth offering.
 * What keeps VBScript safe is the zone, checked by the caller: `tag.class` is
 * also the shape of every member expression in the language — Response.CharSet,
 * Request.Form, Server.MapPath — and no amount of inspecting the token tells the
 * two apart.
 */
export function looksLikeAbbreviation(token: string): boolean {
    if (!token || token.includes('<')) { return false; }

    // A member of one of ASP's intrinsic objects is code, wherever it appears.
    // The zone check above is the real defence, but it reads a page the way the
    // engine does, and the engine ends a block at the first `%>` — even one
    // inside a string. Everything after such a block is an HTML zone by the
    // engine's own rule, so `Response.CharSet` on the next line would otherwise
    // be offered to Emmet with nothing left to stop it.
    const root = token.split(/[.#>+^*]/, 1)[0];
    if (ASP_OBJECT_NAMES.has(root.toLowerCase())) { return false; }

    return ABBREVIATION_OPERATORS.test(token) || ABBREVIATION_SHORTHAND.test(token);
}

/**
 * Emmet's Tab expansion, falling back to a plain Tab when nothing expanded.
 *
 * Tab is bound to `asp.insertTab` for this language, so everything the Tab key
 * would otherwise do has to happen here — and one of those things is Emmet
 * turning `ul>li*3` into a real list, which is how HTML gets written by hand.
 * Going straight to the native `tab` command swallowed it, because that command
 * knows nothing about abbreviations.
 *
 * Emmet is offered the caret in two cases:
 *
 *   * the user turned on `emmet.triggerExpansionOnTab`, in which case they have
 *     asked for VS Code's own behaviour and every word is a candidate;
 *   * otherwise, only when the text before the caret carries an unmistakable
 *     abbreviation marker — see ABBREVIATION_OPERATORS. That is a deliberate
 *     divergence from a .html file, where the same keystroke does nothing: an
 *     abbreviation is the whole reason to reach for Tab there, and requiring a
 *     hidden setting to get it is worse than the small surprise of `a>b`
 *     expanding.
 *
 * Only the HTML and CSS zones are offered at all. Inside `<% %>` an abbreviation
 * like `ul>li*3` is a comparison between two undeclared variables, and inside
 * `<script>` it is JavaScript; expanding either would replace working code with
 * markup.
 */
async function expandAbbreviationOrTab(
    editor:   vscode.TextEditor,
    position: vscode.Position,
): Promise<void> {
    const triggerOnTab = vscode.workspace
        .getConfiguration('emmet', editor.document.uri)
        .get<boolean>('triggerExpansionOnTab', false);

    const lineText = editor.document.lineAt(position.line).text;
    const worthTrying = triggerOnTab
        || looksLikeAbbreviation(tokenBefore(lineText, position.character));

    if (worthTrying) {
        const zone = getZone(editor.document.getText(), editor.document.offsetAt(position));
        if (zone === 'html' || zone === 'css') {
            const outcome = await tryEmmetExpansion(editor, zone);
            if (outcome === 'expanded') { return; }

            // Emmet's own failure path ends in `executeCommand('tab')`, but only
            // when emmet.triggerExpansionOnTab is on. So when it is on and Emmet
            // was asked, the Tab has already been dealt with and inserting
            // another indents twice.
            //
            // Asking the document whether it changed does not settle this: the
            // `tab` command can resolve before its edit is applied, so the check
            // sometimes sees the old version and sometimes the new one. That
            // showed up as an intermittent double indent. The setting is the
            // reliable signal, because it is what Emmet itself branches on.
            if (outcome === 'ran' && triggerOnTab) { return; }
        }
    }

    await vscode.commands.executeCommand('tab');
}

/**
 * Emmet's own commands, in the order worth trying.
 *
 * `emmet.expandAbbreviation` is the one the Emmet extension registers, and the
 * only one that takes arguments — it accepts `{ language }` and falls back to
 * the document's own language id only when none is given. Since `asp` is
 * deliberately absent from emmet.includeLanguages, naming the syntax is what
 * makes expansion work at all, so it is tried first.
 *
 * `editor.emmet.action.expandAbbreviation` is an editor action registered by
 * VS Code itself rather than by the Emmet extension. It ignores arguments and
 * reads the document's language, so for an .asp file it does nothing; it stays
 * as a fallback for a build where the first command is missing.
 */
const EMMET_EXPAND_COMMANDS = [
    'emmet.expandAbbreviation',
    'editor.emmet.action.expandAbbreviation',
];

/**
 * Asks Emmet to expand whatever is under the caret. Returns true if it did.
 *
 * Emmet is a built-in extension, which means it can be disabled — and when it
 * is, invoking the command rejects with "command 'emmet.expandAbbreviation' not
 * found". Letting that propagate out of the Tab handler did two bad things at
 * once: it put an error notification in front of the user, and it swallowed the
 * keystroke, so Tab stopped inserting anything at all. A failure here has to
 * degrade to an ordinary Tab silently.
 *
 * Whether the document changed is the only signal that Emmet acted, because it
 * reports nothing when the text under the caret is not an abbreviation.
 */
type EmmetOutcome =
    | 'expanded'      // Emmet rewrote the abbreviation
    | 'ran'           // Emmet was asked and declined; it may have run `tab` itself
    | 'unavailable';  // no expand command could be invoked at all

/**
 * How long to keep waiting for Emmet's edit after its command has resolved.
 *
 * Reading `document.version` the moment the command returns does not work:
 * Emmet expands through `editor.insertSnippet`, and that applies the edit in the
 * editor before the extension host's copy of the document has caught up. Measured
 * in a real Extension Host, an expansion that plainly succeeded still reported
 * version 1 → 1 on return and only reached version 2 afterwards — so the check
 * said "no expansion" EVERY time, and the caller's fallback dropped an indent
 * into the snippet's first tabstop: `ul>li*3` + Tab gave `<li>    </li>`.
 *
 * The change event is the signal that does arrive, and only the one IPC hop
 * behind, so the wait is short and is cut off by the first event. It is also only
 * ever paid when Emmet DECLINED — an expansion resolves as soon as its edit lands.
 */
const EMMET_EDIT_GRACE_MS = 300;

/** Resolves true if `document` changes within `EMMET_EDIT_GRACE_MS`. */
function waitForEdit(document: vscode.TextDocument): { settled: () => Promise<boolean>, dispose: () => void } {
    let changed = false;
    let notify: (() => void) | undefined;
    const subscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== document || event.contentChanges.length === 0) { return; }
        changed = true;
        notify?.();
    });

    return {
        dispose: () => subscription.dispose(),
        settled: () => new Promise<boolean>(resolve => {
            const finish = (result: boolean) => {
                clearTimeout(timer);
                subscription.dispose();
                resolve(result);
            };
            if (changed) { finish(true); return; }
            notify = () => finish(true);
            const timer = setTimeout(() => finish(false), EMMET_EDIT_GRACE_MS);
        }),
    };
}

async function tryEmmetExpansion(editor: vscode.TextEditor, zone: Zone): Promise<EmmetOutcome> {
    // The syntax is named explicitly because it has to be: `asp` is deliberately
    // absent from emmet.includeLanguages — that mapping is per language and
    // would offer abbreviations inside <% %> too, which is why the suggest-widget
    // route is served by this extension's own provider instead. Naming the
    // syntax per call is also what gets a caret inside <style> treated as CSS.
    const language = zone === 'css' ? 'css' : 'html';

    for (const command of EMMET_EXPAND_COMMANDS) {
        const edit = waitForEdit(editor.document);
        try {
            await vscode.commands.executeCommand(command, { language });
        } catch {
            edit.dispose();
            continue;   // not registered in this build, or Emmet is disabled
        }

        // The first command that RAN settles it — trying the next after a no-op
        // would ask Emmet to act twice on one keystroke.
        return await edit.settled() ? 'expanded' : 'ran';
    }

    warnEmmetUnavailableOnce();
    return 'unavailable';
}

let warnedAboutEmmet = false;

/**
 * Says once why an abbreviation did nothing.
 *
 * Swallowing the failure is right — a dialog every time someone presses Tab
 * would be far worse than a Tab that just indents — but it leaves no trace at
 * all, and "Emmet is turned off" is not something anyone would guess from a
 * silent no-op. The log is where that belongs: no interruption, and still
 * findable from Help > Toggle Developer Tools when someone goes looking.
 */
function warnEmmetUnavailableOnce(): void {
    if (warnedAboutEmmet) { return; }
    warnedAboutEmmet = true;
    console.warn(
        '[ASP] Emmet did not respond, so Tab inserted an indent instead of '
        + 'expanding an abbreviation. Emmet is a built-in extension and may be '
        + 'disabled — check the Extensions view with the filter "@builtin emmet".',
    );
}

export function registerTabKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertTab', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('tab');
        }

        // Multi-cursor: the smart single-cursor indent below can't serve N cursors,
        // so defer to the native tab, which indents at every cursor.
        if (editor.selections.length > 1) {
            return vscode.commands.executeCommand('tab');
        }

        const position  = editor.selection.active;
        const lineText  = editor.document.lineAt(position.line).text;

        // Only apply smart indent on a completely blank line. Anything else is a
        // plain Tab — or an Emmet abbreviation waiting to be expanded.
        if (lineText.trim() !== '') {
            return expandAbbreviationOrTab(editor, position);
        }

        // ...and only when the cursor is at the END of that blank line. If there is
        // whitespace after the cursor, behave like a normal Tab — insert an indent
        // at the cursor and preserve what follows — instead of snapping the whole
        // line (which discarded the trailing spaces and mis-placed the cursor).
        if (position.character !== lineText.length) {
            return vscode.commands.executeCommand('tab');
        }

        // Fetch document text once — only reached on blank lines where smart
        // indent actually runs, so this allocation is never wasted on normal tabs.
        const fullText = editor.document.getText();

        const indentUnit = getIndentUnit(editor);

        // Find nearest non-empty line above
        let baseIndent   = '';
        let prevLineText = '';
        for (let i = position.line - 1; i >= 0; i--) {
            const text = editor.document.lineAt(i).text;
            if (text.trim().length > 0) {
                baseIndent   = text.match(/^(\s*)/)?.[1] ?? '';
                prevLineText = text.trim();
                break;
            }
        }

        const currentIndent = lineText.match(/^(\s*)/)?.[1] ?? '';
        const inAsp = getZone(fullText, editor.document.offsetAt(position)) === 'asp';

        let targetIndent: string;
        if (prevLineText === '%>') {
            // After a closing %> fragment delimiter, we're back in HTML context.
            // Use the enclosing HTML opener's child indent — same logic as Enter after %>.
            targetIndent = findEnclosingHtmlChildIndent(editor.document, position.line, indentUnit)
                           ?? baseIndent;
        } else if (prevLineText.startsWith('<%')) {
            // After <% — VBScript code is at the same level as <%, no extra indent
            targetIndent = baseIndent;
        } else if (inAsp && isBlockOpener(prevLineText)) {
            targetIndent = baseIndent + indentUnit;
        } else if (inAsp) {
            targetIndent = baseIndent;
        } else {
            // Plain HTML / <script> / <style>:
            // Add one extra level when the previous line opens a block.
            // A JS/CSS block opener ends with '{'.
            // An HTML block opener ends with '>' and is a non-self-closing, non-inline tag.
            const htmlOpenerMatch = prevLineText.match(/^<(\w+)(\s[^>]*)?>$/);
            const isHtmlOpener = htmlOpenerMatch
                && !isInlineTag(htmlOpenerMatch[1])
                && !isSelfClosingTag(htmlOpenerMatch[1]);
            const opensBlock = prevLineText.endsWith('{') || !!isHtmlOpener;
            targetIndent = opensBlock ? baseIndent + indentUnit : baseIndent;
        }

        // Snap up to correct level if below it, otherwise freely +1
        const newIndent = currentIndent.length < targetIndent.length
            ? targetIndent
            : currentIndent + indentUnit;

        // Replace the line's ENTIRE leading whitespace (the line is blank here),
        // not just col-0 → cursor. Using `position` as the range end left the
        // existing spaces in place when the cursor sat before them (e.g. at col 0),
        // producing doubled/misplaced indentation.
        return editor.edit(eb => {
            eb.replace(
                new vscode.Range(new vscode.Position(position.line, 0), new vscode.Position(position.line, lineText.length)),
                newIndent,
            );
        }).then(() => {
            const p = new vscode.Position(position.line, newIndent.length);
            editor.selection = new vscode.Selection(p, p);
        });
    });

    context.subscriptions.push(disposable);
}

// ── Single quotes in VBScript ──────────────────────────────────────────────
//
// VS Code auto-closes quotes from the DOCUMENT's language configuration, not
// from the embedded language under the caret — measured: a `'` typed in the
// markup, a <style> or a <script> of an .asp page follows asp's rules. So
// language-configuration.json closes `'` with the very pair html uses, and those
// three zones behave exactly as a .html file does, typing over the quote and
// deleting the pair included, under the user's own editor.autoClosing* settings.
//
// VBScript is the exception, because there `'` starts a comment. The closing
// quote VS Code has just added is removed again here. Removing a character
// AFTER the caret leaves the caret where it is, and the edit is refused if the
// document has moved on, in which case the next change retries it.
//
// This replaces an override of the global `type` command, which doubled every
// apostrophe in page text (`don't` came out as `don't'`), ignored the user's
// settings, sent every keystroke in every editor through the extension host,
// and could not activate beside another extension that owns `type` (Vim).

/** A position in a document, as line and character. */
interface QuotePosition { line: number; character: number; }

/**
 * Where each `''` VS Code auto-inserted now sits, from change ranges given in
 * PRE-edit coordinates: every earlier insertion on the same line pushes a later
 * one two columns right.
 */
export function insertedPairPositions(starts: readonly QuotePosition[]): QuotePosition[] {
    const ascending = [...starts].sort((a, b) => a.line - b.line || a.character - b.character);
    const earlierOnLine = new Map<number, number>();
    return ascending.map(({ line, character }) => {
        const earlier = earlierOnLine.get(line) ?? 0;
        earlierOnLine.set(line, earlier + 1);
        return { line, character: character + 2 * earlier };
    });
}

/**
 * Moves each position with an edit, or drops it when the edit removes that
 * character or spans lines. Change ranges are in PRE-edit coordinates.
 */
export function shiftQuotePositions(
    positions: readonly QuotePosition[],
    changes: readonly { range: vscode.Range; text: string }[],
): QuotePosition[] {
    const kept: QuotePosition[] = [];
    for (const position of positions) {
        let character = position.character;
        let gone = false;
        for (const { range, text } of changes) {
            if (range.start.line !== range.end.line || text.includes('\n')) {
                if (range.start.line <= position.line) { gone = true; }
                continue;
            }
            if (range.start.line !== position.line) { continue; }
            if (range.start.character <= position.character && position.character < range.end.character) { gone = true; }
            else if (range.end.character <= position.character) {
                character += text.length - (range.end.character - range.start.character);
            }
        }
        if (!gone) { kept.push({ line: position.line, character }); }
    }
    return kept;
}

export function registerVbScriptQuoteGuard(context: vscode.ExtensionContext): void {
    // `''` just inserted in VBScript, waiting for the caret to show whether it
    // was an auto-close (caret between the quotes) or a paste (caret after).
    const candidates = new Map<string, QuotePosition[]>();
    // Closing quotes known to be auto-inserted in VBScript, not yet removed.
    const strays = new Map<string, QuotePosition[]>();

    const set = (map: Map<string, QuotePosition[]>, key: string, list: QuotePosition[]) => {
        if (list.length > 0) { map.set(key, list); } else { map.delete(key); }
    };

    const removeStrays = (document: vscode.TextDocument): void => {
        const key = document.uri.toString();
        const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
        const pending = (strays.get(key) ?? []).filter(q =>
            q.line < document.lineCount && document.lineAt(q.line).text[q.character] === "'");
        set(strays, key, pending);
        if (!editor || pending.length === 0) { return; }

        void editor.edit(eb => {
            for (const q of pending) {
                eb.delete(new vscode.Range(q.line, q.character, q.line, q.character + 1));
            }
        }, { undoStopBefore: false, undoStopAfter: false });
    };

    /**
     * Settles the candidates the carets tell apart: a caret between the two
     * quotes means VS Code auto-closed, a caret after both means they were
     * pasted, and those are left alone. The change event can arrive before the
     * editor's selection has caught up, so until the selection event itself
     * (`final`) a candidate neither caret explains is kept waiting.
     */
    const decide = (document: vscode.TextDocument, selections: readonly vscode.Selection[], final: boolean): void => {
        const key = document.uri.toString();
        const waiting = candidates.get(key);
        if (!waiting) { return; }

        const caretAt = (line: number, character: number) =>
            selections.some(s => s.isEmpty && s.active.line === line && s.active.character === character);

        const stillWaiting: QuotePosition[] = [];
        const confirmed:    QuotePosition[] = [];
        for (const q of waiting) {
            if (caretAt(q.line, q.character + 1))         { confirmed.push({ line: q.line, character: q.character + 1 }); }
            else if (!final && !caretAt(q.line, q.character + 2)) { stillWaiting.push(q); }
        }
        set(candidates, key, stillWaiting);
        if (confirmed.length > 0) {
            set(strays, key, [...(strays.get(key) ?? []), ...confirmed]);
            removeStrays(document);
        }
    };

    const onChange = vscode.workspace.onDidChangeTextDocument(event => {
        const document = event.document;
        if (document.languageId !== 'asp' || event.contentChanges.length === 0) { return; }
        const key = document.uri.toString();

        set(strays, key, shiftQuotePositions(strays.get(key) ?? [], event.contentChanges));
        // A candidate that another edit reaches first is no longer decidable.
        candidates.delete(key);

        if (event.reason !== vscode.TextDocumentChangeReason.Undo
            && event.reason !== vscode.TextDocumentChangeReason.Redo) {
            // An auto-closed quote arrives as one edit inserting both quotes.
            const pairs = event.contentChanges.filter(c => c.text === "''" && c.rangeLength === 0);
            if (pairs.length > 0) {
                const fullText = document.getText();
                const inVbScript = insertedPairPositions(pairs.map(c => c.range.start)).filter(p =>
                    getZone(fullText, document.offsetAt(new vscode.Position(p.line, p.character))) === 'asp');
                set(candidates, key, inVbScript);
                const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
                if (editor) { decide(document, editor.selections, false); }
            }
        }

        if (strays.has(key)) { removeStrays(document); }
    });

    const onSelection = vscode.window.onDidChangeTextEditorSelection(event => {
        if (candidates.has(event.textEditor.document.uri.toString())) {
            decide(event.textEditor.document, event.selections, true);
        }
    });

    const onClose = vscode.workspace.onDidCloseTextDocument(document => {
        candidates.delete(document.uri.toString());
        strays.delete(document.uri.toString());
    });

    context.subscriptions.push(onChange, onSelection, onClose);
}