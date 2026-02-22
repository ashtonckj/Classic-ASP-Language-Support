import * as vscode from 'vscode';
import { HTML_TAGS, isSelfClosingTag } from '../constants/htmlTags';
import { getAttributesForTag } from '../constants/htmlGlobals';
import {
    getContext,
    ContextType,
    getCurrentTagName,
    isInsideTagForAttributes,
    isInsideAspBlock
} from '../utils/documentHelper';

// ---------------------------------------------------------------------------
// VBScript block keyword constants
// ---------------------------------------------------------------------------

const VBSCRIPT_BLOCK_OPENERS = /^(If\b.*Then|ElseIf\b.*Then|Else\b|For\b|For\s+Each\b|Do\b|Do\s+While\b|Do\s+Until\b|While\b|Sub\b|Function\b|With\b|Select\s+Case\b|Class\b)/i;
const VBSCRIPT_BLOCK_CLOSERS = /^(End\s+If\b|End\s+Sub\b|End\s+Function\b|End\s+With\b|End\s+Select\b|End\s+Class\b|Next\b|Loop\b|Wend\b|ElseIf\b|Else\b)/i;

// Exact-match regex for auto-snap: line must be ONLY this keyword, nothing else after it
const VBSCRIPT_EXACT_CLOSER =
    /^(End\s+If|End\s+Sub|End\s+Function|End\s+With|End\s+Select|End\s+Class|Next|Loop|Wend|ElseIf(?:\s+.*Then)?|Else)$/i;

const CLOSER_TO_OPENER: { closer: RegExp; opener: RegExp }[] = [
    { closer: /^End\s+If\b/i,       opener: /^If\b.*Then$/i },
    { closer: /^End\s+Sub\b/i,      opener: /^Sub\b/i },
    { closer: /^End\s+Function\b/i, opener: /^Function\b/i },
    { closer: /^End\s+With\b/i,     opener: /^With\b/i },
    { closer: /^End\s+Select\b/i,   opener: /^Select\s+Case\b/i },
    { closer: /^End\s+Class\b/i,    opener: /^Class\b/i },
    { closer: /^Next\b/i,           opener: /^For\b|^For\s+Each\b/i },
    { closer: /^Loop\b/i,           opener: /^Do\b|^Do\s+While\b|^Do\s+Until\b/i },
    { closer: /^Wend\b/i,           opener: /^While\b/i },
    { closer: /^ElseIf\b/i,         opener: /^If\b.*Then$|^ElseIf\b.*Then$/i },
    { closer: /^Else\b/i,           opener: /^If\b.*Then$|^ElseIf\b.*Then$/i },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Faster isInsideAspBlock that avoids fetching the entire document string.
 * Reads only the text up to the position plus a small window ahead.
 */
function isInAspBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
    const before = document.getText(
        new vscode.Range(new vscode.Position(0, 0), position)
    );
    const offset = document.offsetAt(position);
    const docLen = document.getText().length;
    const afterEnd = document.positionAt(Math.min(offset + 5000, docLen));
    const after = document.getText(new vscode.Range(position, afterEnd));

    const lastOpen  = before.lastIndexOf('<%');
    const lastClose = before.lastIndexOf('%>');
    const nextClose = after.indexOf('%>');

    return lastOpen > lastClose && nextClose !== -1;
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

/**
 * Scans upward to find the indent of the opener matching a given closer keyword.
 *
 * Uses per-type depth tracking with foreign-block shielding:
 * - targetDepth counts unmatched closers of our type
 * - foreignDepth[i] counts unmatched closers of every other type
 * - While inside a foreign block, our target openers AND closers are shielded
 *   (ignored), so they don't affect the count
 */
function findMatchingOpenerIndent(
    document: vscode.TextDocument,
    closerLineIndex: number,
    closerText: string
): string | null {
    const targetIdx = CLOSER_TO_OPENER.findIndex(p => p.closer.test(closerText));
    if (targetIdx === -1) { return null; }

    let targetDepth = 1;
    const foreignDepth: number[] = CLOSER_TO_OPENER.map(() => 0);

    for (let i = closerLineIndex - 1; i >= 0; i--) {
        const text = document.lineAt(i).text.trim();
        if (!text) { continue; }

        const closerIdx = CLOSER_TO_OPENER.findIndex(p => p.closer.test(text));
        if (closerIdx !== -1) {
            if (closerIdx === targetIdx) {
                if (!foreignDepth.some(d => d > 0)) {
                    targetDepth++;
                }
            } else {
                foreignDepth[closerIdx]++;
            }
            continue;
        }

        const openerIdx = CLOSER_TO_OPENER.findIndex(p => p.opener.test(text));
        if (openerIdx !== -1) {
            if (openerIdx === targetIdx) {
                if (!foreignDepth.some(d => d > 0)) {
                    targetDepth--;
                    if (targetDepth === 0) {
                        const m = document.lineAt(i).text.match(/^(\s*)/);
                        return m ? m[1] : '';
                    }
                }
            } else {
                if (foreignDepth[openerIdx] > 0) {
                    foreignDepth[openerIdx]--;
                }
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Cached completion items — built once, reused on every keystroke
// ---------------------------------------------------------------------------

let _cachedTagCompletions: vscode.CompletionItem[] | null = null;
const _cachedAttrCompletions = new Map<string, vscode.CompletionItem[]>();

function getTagCompletions(): vscode.CompletionItem[] {
    if (_cachedTagCompletions) { return _cachedTagCompletions; }

    _cachedTagCompletions = HTML_TAGS.map(tag => {
        const item = new vscode.CompletionItem(tag.tag, vscode.CompletionItemKind.Property);
        item.detail = tag.description;
        item.documentation = new vscode.MarkdownString(`HTML <${tag.tag}> element\n\n${tag.description}`);
        item.insertText = isSelfClosingTag(tag.tag)
            ? new vscode.SnippetString(`${tag.tag} $0/>`)
            : new vscode.SnippetString(`${tag.tag}>\n\t$0\n</${tag.tag}>`);
        item.sortText = '2_' + tag.tag;
        return item;
    });

    return _cachedTagCompletions;
}

function getAttributeCompletions(tagName: string): vscode.CompletionItem[] {
    const key = tagName.toLowerCase();
    if (_cachedAttrCompletions.has(key)) { return _cachedAttrCompletions.get(key)!; }

    const items = getAttributesForTag(tagName).map(attr => {
        const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
        item.detail = attr.description;
        item.documentation = new vscode.MarkdownString(`**${attr.name}** attribute\n\n${attr.description}`);
        item.insertText = attr.name.endsWith('-')
            ? new vscode.SnippetString(`${attr.name}$1="$2"`)
            : new vscode.SnippetString(`${attr.name}="$0"`);
        item.sortText = '2_' + attr.name;
        return item;
    });

    _cachedAttrCompletions.set(key, items);
    return items;
}

// ---------------------------------------------------------------------------
// Completion provider
// ---------------------------------------------------------------------------

export class HtmlCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const config = vscode.workspace.getConfiguration('aspLanguageSupport');
        if (!config.get<boolean>('enableHTMLCompletion', true)) { return []; }
        if (getContext(document, position) !== ContextType.HTML) { return []; }

        const textBefore = document.lineAt(position.line).text.substring(0, position.character);

        if (context.triggerCharacter === '<') { return getTagCompletions(); }
        if (textBefore.match(/<(\w+)$/))      { return getTagCompletions(); }

        if (isInsideTagForAttributes(document, position)) {
            const tagName = getCurrentTagName(document, position);
            if (tagName) {
                const afterTagName = textBefore.match(/<\w+\s+(.*)$/);
                if (afterTagName && afterTagName[1].trim().length > 0) {
                    return getAttributeCompletions(tagName);
                }
                if (context.triggerCharacter === ' ') {
                    return getAttributeCompletions(tagName);
                }
            }
        }

        return [];
    }
}

// ---------------------------------------------------------------------------
// Auto-closing tag + auto-snap VBScript closers
// ---------------------------------------------------------------------------

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
                const textAfter = line.text.substring(position.character + 1);
                if (!textAfter.trim().startsWith('-->')) {
                    const insertPos = new vscode.Position(position.line, position.character + 1);
                    editor.edit(eb => eb.insert(insertPos, '  -->')).then(() => {
                        const p = new vscode.Position(position.line, position.character + 2);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
            }
            return;
        }

        // ---- HTML tag auto-close: <div> → <div></div>
        if (change.text === '>') {
            const position       = change.range.start;
            const line           = event.document.lineAt(position.line);
            const textBefore     = line.text.substring(0, position.character);
            const textAfterCursor = line.text.substring(position.character + 1);

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

        const changePos     = change.range.start;
        const currentLine   = event.document.lineAt(changePos.line);
        const currentTrimmed = currentLine.text.trim();
        const currentIndent  = currentLine.text.match(/^(\s*)/)?.[1] ?? '';

        if (!VBSCRIPT_EXACT_CLOSER.test(currentTrimmed)) { return; }
        if (!isInAspBlock(event.document, new vscode.Position(changePos.line, currentLine.text.length))) { return; }

        const openerIndent = findMatchingOpenerIndent(event.document, changePos.line, currentTrimmed);
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

// ---------------------------------------------------------------------------
// Enter key handler
// ---------------------------------------------------------------------------

export function registerEnterKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertLineBreak', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('default:type', { text: '\n' });
        }

        const position        = editor.selection.active;
        const document        = editor.document;
        const line            = document.lineAt(position.line);
        const textBefore      = line.text.substring(0, position.character);
        const textAfter       = line.text.substring(position.character);
        const currentLineText = textBefore.trim();
        const indent          = textBefore.match(/^(\s*)/)?.[0] || '';
        const indentUnit      = getIndentUnit(editor);

        // ----------------------------------------------------------------
        // ASP / VBScript block handling
        // ----------------------------------------------------------------
        if (isInAspBlock(document, position)) {

            // After <% or <%= → same indent, no extra level
            if (/^<%=?$/.test(currentLineText)) {
                editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }

            // Block closer → snap to matching opener indent, newline at same level.
            // Done in a single edit to avoid the two-step flicker.
            if (VBSCRIPT_BLOCK_CLOSERS.test(currentLineText)) {
                const openerIndent = findMatchingOpenerIndent(document, position.line, currentLineText);
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

            // Block opener → next line +1
            if (VBSCRIPT_BLOCK_OPENERS.test(currentLineText)) {
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

        // ----------------------------------------------------------------
        // HTML context handling
        // ----------------------------------------------------------------

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
                editor.edit(eb => eb.insert(position, `>\n${indent}${indentUnit}\n\n${indent}${closingTag}`)).then(() => {
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

// ---------------------------------------------------------------------------
// Tab key handler
// ---------------------------------------------------------------------------

export function registerTabKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertTab', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('tab');
        }

        const position = editor.selection.active;
        const lineText = editor.document.lineAt(position.line).text;

        // Only apply smart indent on a completely blank line
        if (lineText.trim() !== '') {
            return vscode.commands.executeCommand('tab');
        }

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
        const inAsp = isInAspBlock(editor.document, position);

        let targetIndent: string;
        if (/^<%/.test(prevLineText)) {
            targetIndent = baseIndent;
        } else if (inAsp && VBSCRIPT_BLOCK_OPENERS.test(prevLineText)) {
            targetIndent = baseIndent + indentUnit;
        } else if (inAsp) {
            targetIndent = baseIndent;
        } else {
            targetIndent = baseIndent + indentUnit;
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