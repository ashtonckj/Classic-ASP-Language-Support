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
import { aspCodeStartOnLine } from '../../platform/documentHelper';
import { applyIndentForLine } from '../../formatter/aspFormatter';
import { getStringAlignColumn } from '../../vbscript/indentRules';
import { lineAt, walkStatements, type ParsedPage } from '../../vbscript/symbols';

export { VBSCRIPT_BLOCK_CLOSERS, VBSCRIPT_EXACT_CLOSER, VBSCRIPT_MID_BLOCK } from '../../vbscript/indentRules';

/** Lines by number; a vscode.TextDocument is one. */
export interface Lines { lineAt(line: number): { text: string } }

const indentOf = (text: string) => /^\s*/.exec(text)![0];

// ── Line-continuation helpers ──────────────────────────────────────────────

/**
 * The first line of the `_` chain that ends at `line`: `line` itself unless the
 * line above continues into it. A blank line ends a chain, as cscript reads it.
 */
function chainStart(document: Lines, line: number): number {
    let start = line;
    while (start > 0 && endsWithContinuation(document.lineAt(start - 1).text)) { start--; }
    return start;
}

/**
 * The indent of the line after line `line` of VBScript, whose text up to the
 * caret is `text`. Enter and Tab both ask this, so they indent alike, and by
 * the formatter's own rule (applyIndentForLine).
 */
export function vbNextLineIndent(document: Lines, line: number, text: string, indentUnit: string): string {
    const indent = indentOf(text);
    const from = aspCodeStartOnLine(text, text.length);

    if (endsWithContinuation(text, from)) {
        // A string joined with `& _` lines up under the string it started with.
        if (!/[&+]\s*_\s*$/.test(text)) { return indent + indentUnit; }
        const col = getStringAlignColumn(text, from);
        return col >= 0 ? ' '.repeat(col) : indent;
    }
    // The last line of a chain: back to where its statement started.
    if (line > 0 && endsWithContinuation(document.lineAt(line - 1).text)) {
        return indentOf(document.lineAt(chainStart(document, line)).text);
    }

    const code = splitCodeAndComment(text, from).code.slice(from).trim();
    // From a level deep enough that no closer stops at zero, so only the step counts.
    const { printLevel, endLevel } = applyIndentForLine(code, 10, []);
    const step = endLevel - printLevel;
    return step >= 0 ? indent + indentUnit.repeat(step) : indent.slice(0, Math.max(0, indent.length + step * indentUnit.length));
}

/**
 * The indent the block keyword that starts line `line` of `page` snaps to, as
 * the parser pairs it: a closer (End If, Next, Loop…) to its opener's line;
 * ElseIf/Else to the branch above it; Case to the Case above it, or one level
 * inside Select Case for the first. Null when the keyword belongs to no block.
 */
export function findMatchingOpenerIndent(page: ParsedPage, line: number, indentUnit: string): string | null {
    const indentOfLineAt = (offset: number) => {
        const start = page.lineStarts[lineAt(page, offset)];
        return /^[ \t]*/.exec(page.text.slice(start, offset))![0];
    };
    const space = /[ \t]*/y;
    space.lastIndex = page.lineStarts[line];
    const at = page.lineStarts[line] + space.exec(page.text)![0].length;

    let found: string | null = null;
    for (const program of page.programs) {
        walkStatements(program.body, s => {
            if (found !== null || !('opener' in s)) { return; }
            if (s.closer?.start === at) { found = indentOfLineAt(s.opener.start); return; }
            if (s.kind === 'If' && !s.singleLine) {
                const i = s.branches.findIndex(b => b.start === at);
                if (i > 0) { found = indentOfLineAt(s.branches[i - 1].start); }
            } else if (s.kind === 'Select') {
                const i = s.cases.findIndex(c => c.start === at);
                if (i === 0) { found = indentOfLineAt(s.opener.start) + indentUnit; }
                if (i > 0) { found = indentOfLineAt(s.cases[i - 1].start); }
            }
        });
    }
    return found;
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
