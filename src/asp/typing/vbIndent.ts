/**
 * vbIndent.ts  (asp/typing/)
 *
 * The VBScript indent rules the typing helpers share: which lines open, close
 * or sit in the middle of a block, where a closer's opener is, and how a line
 * continued with `_` lines up, read from the editor's document. The rules
 * themselves are vbscript/indentRules.ts, which the formatter reads too.
 */

import * as vscode from 'vscode';
import { isInlineTag, isSelfClosingTag } from '../../constants/htmlTags';
import { endsWithContinuation, splitCodeAndComment } from '../../core/vbLexical';
import { CLOSER_TO_OPENER } from '../../vbscript/indentRules';

export {
    VBSCRIPT_BLOCK_CLOSERS, VBSCRIPT_EXACT_CLOSER, VBSCRIPT_MID_BLOCK, getStringAlignColumn, isBlockOpener,
} from '../../vbscript/indentRules';

// ── Line-continuation helpers ──────────────────────────────────────────────

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
        if (endsWithContinuation(t)) {
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
export function findMatchingOpenerIndent(
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
        const prevLineEnds = i > 0 && endsWithContinuation(document.lineAt(i - 1).text);

        if (endsWithContinuation(rawLine) || prevLineEnds) {
            // Part of a continuation chain — resolve the full logical line.
            const resolved = getLogicalLineEndingAt(document, i);
            text = splitCodeAndComment(resolved.text).code.trim();
            startLine = resolved.startLine;
            // Jump i past the earlier physical lines of this chain so the outer
            // loop doesn't re-process them.
            if (resolved.startLine < i) {
                i = resolved.startLine;
            }
        } else {
            // Fast path — plain line with no continuation involved. Strip a trailing
            // ' comment so `If b Then   ' note` still matches the If opener.
            text = splitCodeAndComment(rawLine).code.trim();
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
export function findAspOpenerIndent(document: vscode.TextDocument, closerLineIndex: number): string | null {
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
export function findEnclosingHtmlChildIndent(
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

// ── String-continuation alignment helpers ─────────────────────────────────


/**
 * Scans upward from `fromLine` (exclusive) to find the first line of a
 * VBScript line-continuation chain — i.e. the line whose previous line does
 * NOT end with `_`.  Returns that line's leading whitespace (base indent).
 *
 * If the scan reaches the top of the document without finding a non-continuation
 * predecessor, it returns the indent of the topmost line examined.
 */
export function findContinuationChainBaseIndent(
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
        const isContinuation = endsWithContinuation(text);
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
