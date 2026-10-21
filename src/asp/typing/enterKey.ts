/**
 * enterKey.ts  (asp/typing/)
 *
 * Enter in an ASP page: the indent of the new line, by zone — VBScript blocks,
 * markup, JavaScript and CSS braces, JSDoc comments.
 */

import * as vscode from 'vscode';
import { isSelfClosingTag } from '../../constants/htmlTags';
import { zonesFor } from '../../platform/documentState';
import {
    findAspOpenerIndent, findEnclosingHtmlChildIndent, findMatchingOpenerIndent, vbNextLineIndent,
    VBSCRIPT_BLOCK_CLOSERS, VBSCRIPT_MID_BLOCK,
} from './vbIndent';
import { getIndentUnit, insertAndPlaceCaret } from './editing';
import { parsedDocument } from '../vbscriptWorkspace';

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

        // An edit that lands between reading the line and applying ours (an
        // auto-close insert, another extension) makes VS Code reject it, and the
        // keystroke was lost; the native newline still goes in.
        const place = (at: vscode.Position | vscode.Range, text: string, caret: vscode.Position) =>
            insertAndPlaceCaret(editor, at, text, caret).then(applied => {
                if (!applied) { void vscode.commands.executeCommand('default:type', { text: '\n' }); }
            });

        const position        = editor.selection.active;
        const document        = editor.document;
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
            void place(position, `\n${indent}`, new vscode.Position(position.line + 1, indent.length));
            return;
        }

        const zone = zonesFor(document).zoneAt(document.offsetAt(position));

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
                    void place(new vscode.Range(position, new vscode.Position(position.line, line.text.length)), `\n${indent} * \n${indent} */`, new vscode.Position(position.line + 1, indent.length + 3));
                    return;
                }
            }

            // Continuing an existing block: the line up to the cursor is just
            // `*` (optionally followed by more text), and the line above is
            // part of the same, still-open comment.
            if (JSDOC_CONTINUATION_LINE.test(textBefore) && position.line > 0
                && continuesOpenJsDocComment(document.lineAt(position.line - 1).text)) {
                void place(position, `\n${indent}* `, new vscode.Position(position.line + 1, indent.length + 2));
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
                void place(new vscode.Range(position, new vscode.Position(position.line, line.text.length)), `\n${indent}${indentUnit}\n${indent}${rest}`, new vscode.Position(position.line + 1, indent.length + indentUnit.length));
            } else {
                void place(position, `\n${indent}${indentUnit}`, new vscode.Position(position.line + 1, indent.length + indentUnit.length));
            }
            return;
        }

        // ── ASP / VBScript block handling ───────────────────────────────

        // Expand <%|%> on Enter.
        // VBScript code sits at the same indent as <% itself — no extra level.
        // <% and %> are at HTML child level; code between them is at that same level.
        if (/^<%=?\s*$/.test(textBefore.trim()) && textAfter.trimEnd() === '%>') {
            void place(new vscode.Range(position, new vscode.Position(position.line, line.text.length)), `\n${indent}\n${indent}%>`, new vscode.Position(position.line + 1, indent.length));
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
                void place(new vscode.Range(new vscode.Position(position.line, 0), lineEnd), `${targetIndent}${currentLineText}\n${htmlChildIndent}`, new vscode.Position(position.line + 1, htmlChildIndent.length));
            } else {
                void place(position, `\n${htmlChildIndent}`, new vscode.Position(position.line + 1, htmlChildIndent.length));
            }
            return;
        }

        if (zone === 'asp') {
            // Else, Case and a closer such as End If first snap to their opener's indent.
            const snapped = VBSCRIPT_MID_BLOCK.test(currentLineText) || VBSCRIPT_BLOCK_CLOSERS.test(currentLineText)
                ? findMatchingOpenerIndent(parsedDocument(document), position.line, indentUnit) ?? indent
                : indent;
            const next = vbNextLineIndent(document, position.line, snapped + textBefore.trimStart(), indentUnit);
            const caret = new vscode.Position(position.line + 1, next.length);
            if (snapped !== indent) {
                const lineEnd = new vscode.Position(position.line, indent.length + currentLineText.length);
                void place(new vscode.Range(new vscode.Position(position.line, 0), lineEnd), `${snapped}${currentLineText}\n${next}`, caret);
            } else {
                void place(position, `\n${next}`, caret);
            }
            return;
        }

        // ── HTML context handling ───────────────────────────────────────

        // Script and style bodies are not markup: `i<n;i++)` is not a tag to
        // close. Only the <script>/<style> tag just typed, which the caret is
        // already past, still opens its body.
        if (zone !== 'html' && !/<(script|style)\b[^>]*>$/i.test(textBefore)) {
            void place(position, `\n${indent}`, new vscode.Position(position.line + 1, indent.length));
            return;
        }

        // HTML comment: <!-- | -->
        if (textBefore.trim().endsWith('<!--') && textAfter.trim().startsWith('-->')) {
            void place(new vscode.Range(position, line.range.end),
                `\n${indent}${indentUnit}\n${indent}-->`, new vscode.Position(position.line + 1, indent.length + indentUnit.length));
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
                        void place(new vscode.Range(position, line.range.end),
                            `\n${indent}${indentUnit}\n${indent}${closingTag}`, new vscode.Position(position.line + 1, indent.length + indentUnit.length));
                    } else {
                        void place(position, `\n${indent}${indentUnit}`, new vscode.Position(position.line + 1, indent.length + indentUnit.length));
                    }
                    return;
                }

                // No closing tag — create it
                void place(position, `\n${indent}${indentUnit}\n${indent}${closingTag}`, new vscode.Position(position.line + 1, indent.length + indentUnit.length));
                return;
            }
        }

        // Incomplete tag: <div|
        const incompleteTagMatch = textBefore.match(/<(\w+)([^>]*)$/);
        if (incompleteTagMatch && !textBefore.endsWith('>')) {
            const tagName = incompleteTagMatch[1];
            if (!isSelfClosingTag(tagName)) {
                const closingTag = `</${tagName}>`;
                void place(position, `>\n${indent}${indentUnit}\n${indent}${closingTag}`, new vscode.Position(position.line + 1, indent.length + indentUnit.length));
                return;
            }
        }

        // Default HTML newline — maintain the current indent. The col-0 and
        // whitespace-only cases already returned to the native newline above, so
        // here the cursor is always past the line's leading whitespace.
        void place(position, `\n${indent}`, new vscode.Position(position.line + 1, indent.length));
        return;
    });

    context.subscriptions.push(disposable);
}
