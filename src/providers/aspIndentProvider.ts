import * as vscode from 'vscode';
import { isSelfClosingTag } from '../constants/htmlTags';
import { isInsideAspBlock, getZone } from '../utils/aspUtils';

// ── VBScript block keyword constants ───────────────────────────────────────

// Pure openers: start a block, next line should be +1 indent
const VBSCRIPT_BLOCK_OPENERS = /^(If\b.*Then|For\b|For\s+Each\b|Do\b|Do\s+While\b|Do\s+Until\b|While\b|Sub\b|Function\b|With\b|Select\s+Case\b|Class\b)/i;

// Pure closers: end a block, snap back to opener indent level
const VBSCRIPT_BLOCK_CLOSERS = /^(End\s+If\b|End\s+Sub\b|End\s+Function\b|End\s+With\b|End\s+Select\b|End\s+Class\b|Next\b|Loop\b|Wend\b)/i;

// Mid-block keywords: close the block above AND open a new block below.
// On Enter they snap to their opener's indent level (+snapOffset), then give +1 on the next line.
// ElseIf/Else are peers of If  → snapOffset 0 (same indent as If)
// Case is subordinate to Select Case → snapOffset 1 (one level inside Select Case)
const VBSCRIPT_MID_BLOCK = /^(ElseIf\b|Else\b|Case\b)/i;

// Exact-match regex for auto-snap (onDidChangeTextDocument)
const VBSCRIPT_EXACT_CLOSER =
    /^(End\s+If|End\s+Sub|End\s+Function|End\s+With|End\s+Select|End\s+Class|Next|Loop|Wend|ElseIf(?:\s+.*Then)?|Else|Case(?:\s+Else)?(?:\s+\S.*)?)$/i;

// Maps each closer/mid-block to its matching opener.
// snapOffset: how many extra indent levels to add on top of the opener's indent when snapping.
//   0 = align flush with opener (ElseIf/Else peers with If)
//   1 = one level inside opener (Case sits inside Select Case)
// family: links mid-block siblings so pure closers (End If) skip past them transparently.
const CLOSER_TO_OPENER: { closer: RegExp; opener: RegExp; isMidBlock?: boolean; snapOffset?: number; family?: string }[] = [
    { closer: /^End\s+If\b/i,       opener: /^If\b.*Then$/i,                    family: 'if' },
    { closer: /^End\s+Sub\b/i,      opener: /^Sub\b/i },
    { closer: /^End\s+Function\b/i, opener: /^Function\b/i },
    { closer: /^End\s+With\b/i,     opener: /^With\b/i },
    { closer: /^End\s+Select\b/i,   opener: /^Select\s+Case\b/i,                 family: 'select' },
    { closer: /^End\s+Class\b/i,    opener: /^Class\b/i },
    { closer: /^Next\b/i,           opener: /^For\b|^For\s+Each\b/i },
    { closer: /^Loop\b/i,           opener: /^Do\b|^Do\s+While\b|^Do\s+Until\b/i },
    { closer: /^Wend\b/i,           opener: /^While\b/i },
    // Mid-block If family — peers of If, snap to its indent (snapOffset 0)
    { closer: /^ElseIf\b/i,         opener: /^If\b.*Then$|^ElseIf\b.*Then$/i,   isMidBlock: true, snapOffset: 0, family: 'if' },
    { closer: /^Else\b/i,           opener: /^If\b.*Then$|^ElseIf\b.*Then$/i,   isMidBlock: true, snapOffset: 0, family: 'if' },
    // Mid-block Select family — Case sits one level inside Select Case (snapOffset 1)
    { closer: /^Case\b/i,           opener: /^Select\s+Case\b/i,                 isMidBlock: true, snapOffset: 1, family: 'select' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns true when `position` is inside a <% ... %> ASP block.
 * Delegates to the canonical comment-aware isInsideAspBlock from documentHelper
 * so that %> inside VBScript comment lines (') is never treated as a close tag.
 *
 * Accepts an optional pre-fetched `docText` so callers that already hold the
 * full document string avoid allocating it a second time.
 */
function isInAspBlock(document: vscode.TextDocument, position: vscode.Position, docText?: string): boolean {
    const text   = docText ?? document.getText();
    const offset = document.offsetAt(position);
    return isInsideAspBlock(text, offset);
}

/**
 * Returns the indent unit string from editor options.
 * Shared by Enter and Tab handlers to avoid duplicating those 3 lines.
 */
function getIndentUnit(editor: vscode.TextEditor): string {
    const tabSize  = editor.options.tabSize as number || 4;
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

    const targetEntry   = CLOSER_TO_OPENER[targetIdx];
    const targetIsMid   = !!targetEntry.isMidBlock;
    const snapOffset    = targetEntry.snapOffset ?? 0;

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
            text      = resolved.text;
            startLine = resolved.startLine;
            // Jump i past the earlier physical lines of this chain so the outer
            // loop doesn't re-process them.
            if (resolved.startLine < i) {
                i = resolved.startLine;
            }
        } else {
            // Fast path — plain line with no continuation involved.
            text      = rawLine.trim();
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
        } else if (/^<%/.test(text)) {
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
    const INLINE_TAGS = /^(a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr|img|input|link|meta|hr|area|base|col|embed|param|source|track)$/i;

    let aspDepth  = 0;
    // closedTags[tag] counts how many closing tags of that name we've passed
    // without yet seeing their opener — those openers must be skipped.
    const closedTags: Record<string, number> = {};

    for (let i = startLine - 1; i >= 0; i--) {
        const raw  = document.lineAt(i).text;
        const text = raw.trim();
        if (!text) { continue; }

        // Skip ASP fragment content (scan backwards: %> raises depth, <% lowers it)
        if (/^%>/.test(text) || (text.endsWith('%>') && !text.startsWith('<%'))) {
            aspDepth++;
            continue;
        }
        if (/^<%/.test(text)) {
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
            if (INLINE_TAGS.test(tag) || isSelfClosingTag(tag)) { continue; }
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

export function registerAutoClosingTag(context: vscode.ExtensionContext) {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) { return; }
        if (event.document.languageId !== 'asp')           { return; }
        if (event.contentChanges.length === 0)             { return; }

        const change = event.contentChanges[0];

        // ---- HTML comment auto-close: <!-- → <!-- | -->
        if (change.text === '-' && change.range.start.character >= 3) {
            const position  = change.range.start;
            const line      = event.document.lineAt(position.line);
            const textBefore = line.text.substring(0, position.character + 1);

            if (textBefore.endsWith('<!--')) {
                // Don't auto-close inside a VBScript block — HTML comments are not valid there
                if (!isInAspBlock(event.document, position)) {
                    const textAfter = line.text.substring(position.character + 1);
                    if (!textAfter.trim().startsWith('-->')) {
                        const insertPos = new vscode.Position(position.line, position.character + 1);
                        editor.edit(eb => eb.insert(insertPos, '  -->')).then(() => {
                            const p = new vscode.Position(position.line, position.character + 2);
                            editor.selection = new vscode.Selection(p, p);
                        });
                    }
                }
            }
            return;
        }

        // ---- HTML tag auto-close: <div> → <div></div>
        if (change.text === '>') {
            const position        = change.range.start;
            const line            = event.document.lineAt(position.line);
            const textBefore      = line.text.substring(0, position.character);
            const textAfterCursor = line.text.substring(position.character + 1);

            // Don't auto-close when `>` is typed inside a quoted attribute value.
            // e.g. <a href="<>"> — the `>` closes the inner `<`, not the tag itself.
            // Scan forward through textBefore tracking quote state to find the last
            // real (outside-quotes) tag-opening `<`. If we're still inside a quote
            // after that point, the `>` belongs inside an attribute value — bail out.
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
                        if (next && /[a-zA-Z\/!]/.test(next)) {
                            lastRealTagOpen = i;
                            inQuote = null;
                        }
                    }
                }
            }
            if (lastRealTagOpen !== -1 && inQuote !== null) { return; }

            const tagMatch = textBefore.match(/<(\w+)(?:\s+[^>]*)?$/);
            if (tagMatch && !isSelfClosingTag(tagMatch[1])) {
                const expectedClosing = `</${tagMatch[1]}>`;
                if (!textAfterCursor.trim().startsWith(expectedClosing)) {
                    const insertPos = new vscode.Position(position.line, position.character + 1);
                    editor.edit(eb => eb.insert(insertPos, expectedClosing)).then(() => {
                        const p = new vscode.Position(position.line, position.character + 1);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
            }
            return;
        }

        // ---- Auto-snap VBScript closer to correct indent when fully typed
        // Skip deletions and whitespace-only changes (Tab/Shift+Tab)
        if (change.text === '' || !/\S/.test(change.text)) { return; }

        const changePos      = change.range.start;
        const currentLine    = event.document.lineAt(changePos.line);
        const currentTrimmed = currentLine.text.trim();
        const currentIndent  = currentLine.text.match(/^(\s*)/)?.[1] ?? '';
        const snapIndentUnit = getIndentUnit(editor);

        // Snap standalone %> to its matching <% indent
        if (currentTrimmed === '%>') {
            const aspOpenerIndent = findAspOpenerIndent(event.document, changePos.line);
            if (aspOpenerIndent !== null && aspOpenerIndent !== currentIndent) {
                editor.edit(eb => {
                    eb.replace(
                        new vscode.Range(
                            new vscode.Position(changePos.line, 0),
                            new vscode.Position(changePos.line, currentIndent.length)
                        ),
                        aspOpenerIndent
                    );
                }).then(() => {
                    const p = new vscode.Position(changePos.line, aspOpenerIndent.length + currentTrimmed.length);
                    editor.selection = new vscode.Selection(p, p);
                });
            }
            return;
        }

        if (!VBSCRIPT_EXACT_CLOSER.test(currentTrimmed)) { return; }

        // getText() is called once here and passed into isInAspBlock so there is
        // only one full-document string allocation per snap event.  This only runs
        // when the line already matches VBSCRIPT_EXACT_CLOSER, so ordinary keystrokes
        // never reach this point.
        const docText = event.document.getText();
        if (!isInAspBlock(event.document, new vscode.Position(changePos.line, currentLine.text.length), docText)) { return; }

        const openerIndent = findMatchingOpenerIndent(event.document, changePos.line, currentTrimmed, snapIndentUnit);
        if (openerIndent === null || openerIndent === currentIndent) { return; }

        editor.edit(eb => {
            eb.replace(
                new vscode.Range(
                    new vscode.Position(changePos.line, 0),
                    new vscode.Position(changePos.line, currentIndent.length)
                ),
                openerIndent
            );
        }).then(() => {
            const p = new vscode.Position(changePos.line, openerIndent.length + currentTrimmed.length);
            editor.selection = new vscode.Selection(p, p);
        });
    });

    context.subscriptions.push(disposable);
}

// ── Enter key handler ──────────────────────────────────────────────────────

export function registerEnterKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertLineBreak', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('default:type', { text: '\n' });
        }

        const position        = editor.selection.active;
        const document        = editor.document;
        const docText         = document.getText();
        const line            = document.lineAt(position.line);
        const textBefore      = line.text.substring(0, position.character);
        const textAfter       = line.text.substring(position.character);
        const currentLineText = textBefore.trim();
        const indent          = textBefore.match(/^(\s*)/)?.[0] || '';
        const indentUnit      = getIndentUnit(editor);

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

        if (isInAspBlock(document, position, docText)) {

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

            // Block opener → next line +1
            // Exception: a single-line If statement (e.g. `If x Then y = 1`) has a
            // real statement after Then and is NOT a block opener — it needs no extra
            // indent on the next line.  A multi-line If ends with Then (optionally
            // followed only by a VBScript comment), so we detect the single-line form
            // by checking whether a non-comment token appears after the Then keyword.
            if (VBSCRIPT_BLOCK_OPENERS.test(currentLineText)) {
                // Matches single-line If: "If … Then <non-comment content>"
                const isSingleLineIf = /^If\b.+\bThen\s+\S/i.test(currentLineText)
                    && !/^If\b.+\bThen\s*'/i.test(currentLineText);
                if (!isSingleLineIf) {
                    editor.edit(eb => eb.insert(position, `\n${indent}${indentUnit}`)).then(() => {
                        const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                    return;
                }
                // Single-line If — fall through to default (keep same indent level)
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

        return vscode.commands.executeCommand('default:type', { text: '\n' });
    });

    context.subscriptions.push(disposable);
}

// ── Tab key handler ────────────────────────────────────────────────────────

export function registerTabKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertTab', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('tab');
        }

        const position  = editor.selection.active;
        const lineText  = editor.document.lineAt(position.line).text;

        // Only apply smart indent on a completely blank line
        if (lineText.trim() !== '') {
            return vscode.commands.executeCommand('tab');
        }

        // Fetch document text once — only reached on blank lines where smart
        // indent actually runs, so this allocation is never wasted on normal tabs.
        const docText   = editor.document.getText();

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
        const inAsp = isInAspBlock(editor.document, position, docText);

        let targetIndent: string;
        if (prevLineText === '%>') {
            // After a closing %> fragment delimiter, we're back in HTML context.
            // Use the enclosing HTML opener's child indent — same logic as Enter after %>.
            targetIndent = findEnclosingHtmlChildIndent(editor.document, position.line, indentUnit)
                           ?? baseIndent;
        } else if (/^<%/.test(prevLineText)) {
            // After <% — VBScript code is at the same level as <%, no extra indent
            targetIndent = baseIndent;
        } else if (inAsp && VBSCRIPT_BLOCK_OPENERS.test(prevLineText)) {
            targetIndent = baseIndent + indentUnit;
        } else if (inAsp) {
            targetIndent = baseIndent;
        } else {
            // Plain HTML / <script> / <style>:
            // Add one extra level when the previous line opens a block.
            // A JS/CSS block opener ends with '{'.
            // An HTML block opener ends with '>' and is a non-self-closing, non-inline tag.
            const INLINE_OR_VOID = /^(a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr|img|input|link|meta|hr|area|base|col|embed|param|source|track)$/i;
            const htmlOpenerMatch = prevLineText.match(/^<(\w+)(\s[^>]*)?>$/);
            const isHtmlOpener = htmlOpenerMatch
                && !INLINE_OR_VOID.test(htmlOpenerMatch[1])
                && !isSelfClosingTag(htmlOpenerMatch[1]);
            const opensBlock = prevLineText.endsWith('{') || !!isHtmlOpener;
            targetIndent = opensBlock ? baseIndent + indentUnit : baseIndent;
        }

        // Snap up to correct level if below it, otherwise freely +1
        const newIndent = currentIndent.length < targetIndent.length
            ? targetIndent
            : currentIndent + indentUnit;

        editor.edit(eb => {
            eb.replace(new vscode.Range(new vscode.Position(position.line, 0), position), newIndent);
        }).then(() => {
            const p = new vscode.Position(position.line, newIndent.length);
            editor.selection = new vscode.Selection(p, p);
        });
    });

    context.subscriptions.push(disposable);
}

// ── Smart single-quote auto-close ─────────────────────────────────────────
// Auto-closes ' → '' in HTML, CSS, and JS zones (where ' is a string delimiter)
// but does nothing in VBScript ASP blocks (where ' starts a comment).
// This gives the ergonomics of auto-closing quotes in the three zones where
// it helps, without the annoyance of a trailing ' on every VBScript comment line.

export function registerSmartQuoteHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) { return; }
        if (event.document.languageId !== 'asp')           { return; }
        if (event.contentChanges.length === 0)             { return; }

        const change = event.contentChanges[0];

        // Only act when a bare single quote was typed (not a paste or multi-char)
        if (change.text !== "'") { return; }

        const position = change.range.start;
        const document = event.document;
        const content  = document.getText();
        const offset   = document.offsetAt(position) + 1; // +1 for the char just inserted

        // Determine zone AFTER the insertion
        const zone = getZone(content, offset);

        // Only auto-close in html / css / js — never in asp (VBScript comment)
        if (zone === 'asp') { return; }

        // Don't auto-close if the character immediately after is already a '
        // (prevents doubling up when cursor is already between quotes)
        const lineText  = document.lineAt(position.line).text;
        const nextChar  = lineText[position.character + 1];
        if (nextChar === "'") { return; }

        // Don't auto-close if we're currently inside a string literal —
        // the typed ' is the closing quote, not an opening one.
        // Quick check: count unescaped ' chars before cursor on the same line.
        const textBefore = lineText.slice(0, position.character + 1);
        let quoteCount   = 0;
        for (let i = 0; i < textBefore.length - 1; i++) {
            if (textBefore[i] === "'" && textBefore[i - 1] !== '\\') { quoteCount++; }
        }
        // Odd number of preceding quotes means we're inside a string — this ' closes it
        if (quoteCount % 2 === 1) { return; }

        // Insert the closing ' and place cursor between the pair
        const insertPos = new vscode.Position(position.line, position.character + 1);
        editor.edit(eb => eb.insert(insertPos, "'"), { undoStopBefore: false, undoStopAfter: false })
            .then(() => {
                const p = new vscode.Position(position.line, position.character + 1);
                editor.selection = new vscode.Selection(p, p);
            });
    });

    context.subscriptions.push(disposable);
}