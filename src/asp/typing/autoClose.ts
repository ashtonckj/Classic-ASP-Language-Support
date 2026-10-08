/**
 * autoClose.ts  (asp/typing/)
 *
 * Closing tags typed for the user: `</` and `>` in markup, `<%` → `<% %>`, and
 * a VBScript closer snapped to its opener's indent.
 */

import * as vscode from 'vscode';
import { isSelfClosingTag } from '../../constants/htmlTags';
import type { Zone } from '../../core/zoneUtils';
import { zonesFor } from '../../platform/documentState';
import { findAspOpenerIndent, findMatchingOpenerIndent, VBSCRIPT_EXACT_CLOSER } from './vbIndent';
import { getIndentUnit } from './editing';

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

        // True when EVERY cursor typed the same single character over an empty
        // selection. Anything else is a paste, a snippet, or a mixed edit, and none
        // of the handlers below apply to it.
        const everyCursorTyped = (ch: string) =>
            changes.every(c => c.text === ch && c.rangeLength === 0);

        // The zones are only read once a cheap text check has already passed —
        // an ordinary keystroke must not scan the whole document.
        const zoneAtPosition = (line: number, character: number) =>
            zonesFor(event.document).zoneAt(event.document.offsetAt(new vscode.Position(line, character)));

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
