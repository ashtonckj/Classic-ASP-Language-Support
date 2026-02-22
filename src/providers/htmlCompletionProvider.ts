import * as vscode from 'vscode';
import { HTML_TAGS, isSelfClosingTag } from '../constants/htmlTags';
import { getAttributesForTag } from '../constants/htmlGlobals';
import {
    getContext,
    ContextType,
    getCurrentTagName,
    isAfterOpenBracket,
    isInsideTagForAttributes,
    getTextBeforeCursor,
    isInsideAspBlock
} from '../utils/documentHelper';

// VBScript keywords that open an indented block.
// Note: Else/ElseIf appear here too because after them the next line should be +1.
const VBSCRIPT_BLOCK_OPENERS = /^(If\b.*Then|ElseIf\b.*Then|Else\b|For\b|For\s+Each\b|Do\b|Do\s+While\b|Do\s+Until\b|While\b|Sub\b|Function\b|With\b|Select\s+Case\b|Class\b)/i;

// VBScript keywords that close a block — the line itself should be de-indented one level.
// Note: Else/ElseIf appear here too because they close the previous If block before opening a new one.
const VBSCRIPT_BLOCK_CLOSERS = /^(End\s+If\b|End\s+Sub\b|End\s+Function\b|End\s+With\b|End\s+Select\b|End\s+Class\b|Next\b|Loop\b|Wend\b|ElseIf\b|Else\b)/i;

// Map each closer keyword to its corresponding opener keyword pattern.
// Used so we can count balanced pairs when scanning upward.
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
    // Else/ElseIf pair back to their If
    { closer: /^ElseIf\b/i,         opener: /^If\b.*Then$|^ElseIf\b.*Then$/i },
    { closer: /^Else\b/i,           opener: /^If\b.*Then$|^ElseIf\b.*Then$/i },
];

/**
 * Given a closer keyword line, scan upward through the document to find
 * the indent of its matching opener.
 *
 * Scans upward keeping a single nesting depth for our target type.
 * Any other block type that is opened but not yet closed (i.e. we've seen its
 * closer but not its opener yet) means we are "inside" that block — and any
 * opener of our target type found while inside a foreign block is shielded
 * and must be ignored.
 *
 * Example:
 *   If ...           ← outer, should match
 *     While ...      ← foreign opener — clears the Wend shield
 *       If ...       ← shielded by Wend above, must be skipped
 *   Wend             ← foreign closer — sets a shield
 *   End If           ← start here
 */
function findMatchingOpenerIndent(
    document: vscode.TextDocument,
    closerLineIndex: number,
    closerText: string
): string | null {
    const targetIdx = CLOSER_TO_OPENER.findIndex(p => p.closer.test(closerText));
    if (targetIdx === -1) { return null; }

    // Depth for our target type (how many unmatched closers of our type remain)
    let targetDepth = 1;

    // Depth for every OTHER block type — if any of these > 0 we are "inside"
    // a foreign block and our target opener should be skipped
    const foreignDepth: number[] = CLOSER_TO_OPENER.map(() => 0);

    for (let i = closerLineIndex - 1; i >= 0; i--) {
        const text = document.lineAt(i).text.trim();
        if (!text) { continue; }

        // Is this line a closer of any type?
        const closerIdx = CLOSER_TO_OPENER.findIndex(p => p.closer.test(text));
        if (closerIdx !== -1) {
            if (closerIdx === targetIdx) {
                // Only count this same-type closer if NOT inside a foreign block
                // (if it IS inside a foreign block it's shielded and irrelevant)
                const insideForeign = foreignDepth.some(d => d > 0);
                if (!insideForeign) {
                    targetDepth++;
                }
            } else {
                foreignDepth[closerIdx]++;  // foreign closer — we are now inside it
            }
            continue;
        }

        // Is this line an opener of any type?
        const openerIdx = CLOSER_TO_OPENER.findIndex(p => p.opener.test(text));
        if (openerIdx !== -1) {
            if (openerIdx === targetIdx) {
                // Only count this opener if we are NOT inside any foreign block
                const insideForeign = foreignDepth.some(d => d > 0);
                if (!insideForeign) {
                    targetDepth--;
                    if (targetDepth === 0) {
                        const m = document.lineAt(i).text.match(/^(\s*)/);
                        return m ? m[1] : '';
                    }
                }
                // If inside a foreign block, this opener is shielded — skip it
            } else {
                // Foreign opener — decrement its shield if one exists
                if (foreignDepth[openerIdx] > 0) {
                    foreignDepth[openerIdx]--;
                }
            }
        }
    }

    return null;
}

export class HtmlCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const config = vscode.workspace.getConfiguration('aspLanguageSupport');
        if (!config.get<boolean>('enableHTMLCompletion', true)) {
            return [];
        }

        const docContext = getContext(document, position);

        // Only provide HTML completions in HTML context
        if (docContext !== ContextType.HTML) {
            return [];
        }

        const lineText = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        // Check if we should provide tag completions
        // Only trigger if user typed '<' followed by at least one character
        if (context.triggerCharacter === '<') {
            return this.provideTagCompletions();
        }

        // For manual invocation, check if there's a partial tag
        const partialTagMatch = textBefore.match(/<(\w+)$/);
        if (partialTagMatch) {
            return this.provideTagCompletions();
        }

        // Check if we should provide attribute completions
        // Only if user is typing inside a tag AND has typed something
        if (isInsideTagForAttributes(document, position)) {
            const tagName = getCurrentTagName(document, position);
            if (tagName) {
                // Check if there's some text being typed (not just space after tag name)
                const afterTagName = textBefore.match(/<\w+\s+(.*)$/);
                if (afterTagName && afterTagName[1].trim().length > 0) {
                    return this.provideAttributeCompletions(tagName);
                }
                // Or if triggered by space, show attributes
                if (context.triggerCharacter === ' ') {
                    return this.provideAttributeCompletions(tagName);
                }
            }
        }

        return [];
    }

    // Provide HTML tag completions
    private provideTagCompletions(): vscode.CompletionItem[] {
        return HTML_TAGS.map(tag => {
            const item = new vscode.CompletionItem(tag.tag, vscode.CompletionItemKind.Property);
            item.detail = tag.description;
            item.documentation = new vscode.MarkdownString(`HTML <${tag.tag}> element\n\n${tag.description}`);

            // Create snippet for auto-closing tags
            if (isSelfClosingTag(tag.tag)) {
                // Self-closing tag like <img />
                item.insertText = new vscode.SnippetString(`${tag.tag} $0/>`);
            } else {
                // Regular tag with closing tag and blank lines
                item.insertText = new vscode.SnippetString(`${tag.tag}>\n\t$0\n</${tag.tag}>`);
            }

            item.sortText = '2_' + tag.tag;
            return item;
        });
    }

    // Provide HTML attribute completions
    private provideAttributeCompletions(tagName: string): vscode.CompletionItem[] {
        const attributes = getAttributesForTag(tagName);

        return attributes.map(attr => {
            const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
            item.detail = attr.description;
            item.documentation = new vscode.MarkdownString(`**${attr.name}** attribute\n\n${attr.description}`);

            // Create snippet with quotes
            if (attr.name.endsWith('-')) {
                // For data- attributes, let user complete the name
                item.insertText = new vscode.SnippetString(`${attr.name}$1="$2"`);
            } else {
                item.insertText = new vscode.SnippetString(`${attr.name}="$0"`);
            }

            item.sortText = '2_' + attr.name;
            return item;
        });
    }
}

// Register auto-closing tag functionality
export function registerAutoClosingTag(context: vscode.ExtensionContext) {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) {
            return;
        }

        // Only work with .asp files
        if (event.document.languageId !== 'asp') {
            return;
        }

        const changes = event.contentChanges;
        if (changes.length === 0) {
            return;
        }

        const change = changes[0];

        // Check if user just typed '<!--' (HTML comment start)
        if (change.text === '-' && change.range.start.character >= 3) {
            const position = change.range.start;
            const line = event.document.lineAt(position.line);
            const textBefore = line.text.substring(0, position.character + 1);

            // Check if we just completed '<!--'
            if (textBefore.endsWith('<!--')) {
                const textAfter = line.text.substring(position.character + 1);

                // Only auto-close if '-->' doesn't already exist right after
                if (!textAfter.trim().startsWith('-->')) {
                    const insertPosition = new vscode.Position(position.line, position.character + 1);

                    editor.edit(editBuilder => {
                        editBuilder.insert(insertPosition, '  -->');
                    }).then(() => {
                        // Move cursor between the comment markers: <!-- | -->
                        const newPosition = new vscode.Position(position.line, position.character + 2);
                        editor.selection = new vscode.Selection(newPosition, newPosition);
                    });
                }
            }
            return;
        }

        // Check if user just typed '>'
        if (change.text === '>') {
            const position = change.range.start;
            const line = event.document.lineAt(position.line);
            const textBeforeClosing = line.text.substring(0, position.character);
            const textAfterCursor = line.text.substring(position.character + 1);

            // Find the opening tag
            const tagMatch = textBeforeClosing.match(/<(\w+)(?:\s+[^>]*)?$/);
            if (tagMatch) {
                const tagName = tagMatch[1];

                // Check if it's not a self-closing tag and not already closed
                if (!isSelfClosingTag(tagName)) {
                    const expectedClosing = `</${tagName}>`;

                    // Check if closing tag already exists right after
                    if (textAfterCursor.trim().startsWith(expectedClosing)) {
                        // Already has closing tag, don't add another
                        return;
                    }

                    const insertPosition = new vscode.Position(position.line, position.character + 1);

                    editor.edit(editBuilder => {
                        editBuilder.insert(insertPosition, expectedClosing);
                    }).then(() => {
                        // Move cursor right after the > (before closing tag)
                        const newPosition = new vscode.Position(position.line, position.character + 1);
                        editor.selection = new vscode.Selection(newPosition, newPosition);
                    });
                }
            }
        }

        // Auto-snap VBScript closer keywords to correct indent as user finishes typing.
        // Fires on insertions only, and only when the whole line is exactly a closer keyword.
        // Only snap when the user typed a real character (not tab/space-only indent changes)
        if (change.text !== '' && /\S/.test(change.text)) {
            const changePosition = change.range.start;
            const currentLine = event.document.lineAt(changePosition.line);
            const currentLineTrimmed = currentLine.text.trim();
            const currentIndent = currentLine.text.match(/^(\s*)/)?.[1] ?? '';

            const isExactCloser =
                /^(End\s+If|End\s+Sub|End\s+Function|End\s+With|End\s+Select|End\s+Class|Next|Loop|Wend|ElseIf(?:\s+.*Then)?|Else)$/i
                .test(currentLineTrimmed);

            if (
                isExactCloser &&
                isInsideAspBlock(event.document.getText(), event.document.offsetAt(
                    new vscode.Position(changePosition.line, currentLine.text.length)
                ))
            ) {
                const openerIndent = findMatchingOpenerIndent(event.document, changePosition.line, currentLineTrimmed);

                if (openerIndent !== null && openerIndent !== currentIndent) {
                    editor.edit(editBuilder => {
                        editBuilder.replace(
                            new vscode.Range(
                                new vscode.Position(changePosition.line, 0),
                                new vscode.Position(changePosition.line, currentIndent.length)
                            ),
                            openerIndent
                        );
                    }).then(() => {
                        const newCol = openerIndent.length + currentLineTrimmed.length;
                        const newPos = new vscode.Position(changePosition.line, newCol);
                        editor.selection = new vscode.Selection(newPos, newPos);
                    });
                }
            }
        }

    });

    context.subscriptions.push(disposable);
}

// Register Enter key handler for auto-closing tags and smart ASP/VBScript indentation
export function registerEnterKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertLineBreak', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('default:type', { text: '\n' });
        }

        const position = editor.selection.active;
        const document = editor.document;
        const line = document.lineAt(position.line);
        const textBefore = line.text.substring(0, position.character);
        const textAfter = line.text.substring(position.character);
        const currentLineText = textBefore.trim();

        const tabSize = editor.options.tabSize as number || 4;
        const useSpaces = editor.options.insertSpaces !== false;
        const indentUnit = useSpaces ? ' '.repeat(tabSize) : '\t';
        const indent = textBefore.match(/^(\s*)/)?.[0] || '';

        // ----------------------------------------------------------------
        // ASP / VBScript block handling
        // ----------------------------------------------------------------
        const inAspBlock = isInsideAspBlock(document.getText(), document.offsetAt(position));

        if (inAspBlock) {
            // Pressing Enter right after <% or <%= → stay at same indent, no extra level
            if (/^<%=?$/.test(currentLineText)) {
                editor.edit(editBuilder => {
                    editBuilder.insert(position, `\n${indent}`);
                }).then(() => {
                    const newPos = new vscode.Position(position.line + 1, indent.length);
                    editor.selection = new vscode.Selection(newPos, newPos);
                });
                return;
            }

            // VBScript block closer on current line → snap this line to its matching opener's
            // indent, then put the next line at that same level.
            if (VBSCRIPT_BLOCK_CLOSERS.test(currentLineText)) {
                const openerIndent = findMatchingOpenerIndent(document, position.line, currentLineText);

                // Only reindent if we found a matching opener AND the current indent is wrong
                const targetIndent = openerIndent !== null ? openerIndent : indent;

                if (targetIndent !== indent) {
                    // First edit: correct this line's indentation
                    editor.edit(editBuilder => {
                        editBuilder.replace(
                            new vscode.Range(
                                new vscode.Position(position.line, 0),
                                new vscode.Position(position.line, indent.length)
                            ),
                            targetIndent
                        );
                    }).then(() => {
                        // Second edit: insert newline with corrected indent
                        const newLineStart = targetIndent.length + currentLineText.length;
                        editor.edit(editBuilder => {
                            editBuilder.insert(
                                new vscode.Position(position.line, newLineStart),
                                `\n${targetIndent}`
                            );
                        }).then(() => {
                            const newPos = new vscode.Position(position.line + 1, targetIndent.length);
                            editor.selection = new vscode.Selection(newPos, newPos);
                        });
                    });
                } else {
                    // Indent is already correct — just insert newline at same level
                    editor.edit(editBuilder => {
                        editBuilder.insert(position, `\n${indent}`);
                    }).then(() => {
                        const newPos = new vscode.Position(position.line + 1, indent.length);
                        editor.selection = new vscode.Selection(newPos, newPos);
                    });
                }
                return;
            }

            // VBScript block opener → next line gets +1 indent
            if (VBSCRIPT_BLOCK_OPENERS.test(currentLineText)) {
                editor.edit(editBuilder => {
                    editBuilder.insert(position, `\n${indent}${indentUnit}`);
                }).then(() => {
                    const newPos = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(newPos, newPos);
                });
                return;
            }

            // Default inside ASP block → match current line's indent exactly
            editor.edit(editBuilder => {
                editBuilder.insert(position, `\n${indent}`);
            }).then(() => {
                const newPos = new vscode.Position(position.line + 1, indent.length);
                editor.selection = new vscode.Selection(newPos, newPos);
            });
            return;
        }

        // ----------------------------------------------------------------
        // HTML context handling (original logic, unchanged)
        // ----------------------------------------------------------------

        // Check if we're inside an HTML comment: <!-- | -->
        if (textBefore.trim().endsWith('<!--') && textAfter.trim().startsWith('-->')) {
            editor.edit(editBuilder => {
                const endOfLine = line.range.end;
                editBuilder.replace(new vscode.Range(position, endOfLine), `\n${indent}${indentUnit}\n${indent}-->`);
            }).then(() => {
                const newPosition = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                editor.selection = new vscode.Selection(newPosition, newPosition);
            });
            return;
        }

        // Check if we just closed a tag: <html>|
        const justClosedTagMatch = textBefore.match(/<(\w+)([^>]*)>$/);

        if (justClosedTagMatch) {
            const tagName = justClosedTagMatch[1];

            if (!isSelfClosingTag(tagName)) {
                const closingTag = `</${tagName}>`;

                const textAfterCursor = document.getText(
                    new vscode.Range(position, document.positionAt(document.getText().length))
                );

                const closingTagRegex = new RegExp(`</${tagName}>`, 'i');
                if (closingTagRegex.test(textAfterCursor)) {
                    if (textAfter.trim().startsWith(closingTag)) {
                        // Closing tag is right after cursor: <div>|</div>
                        // Use replace in a single operation to avoid cursor flicker
                        editor.edit(editBuilder => {
                            const endOfLine = line.range.end;
                            editBuilder.replace(new vscode.Range(position, endOfLine), `\n${indent}${indentUnit}\n${indent}${closingTag}`);
                        }).then(() => {
                            const newPosition = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                            editor.selection = new vscode.Selection(newPosition, newPosition);
                        });
                        return;
                    } else {
                        // Closing tag exists elsewhere, just add newline with indent
                        editor.edit(editBuilder => {
                            editBuilder.insert(position, `\n${indent}${indentUnit}`);
                        }).then(() => {
                            const newPosition = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                            editor.selection = new vscode.Selection(newPosition, newPosition);
                        });
                        return;
                    }
                }

                // No closing tag exists - create it
                editor.edit(editBuilder => {
                    editBuilder.insert(position, `\n${indent}${indentUnit}\n${indent}${closingTag}`);
                }).then(() => {
                    const newPosition = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(newPosition, newPosition);
                });
                return;
            }
        }

        // Check if we're after an incomplete tag: <html|
        const incompleteTagMatch = textBefore.match(/<(\w+)([^>]*)$/);

        if (incompleteTagMatch && !textBefore.endsWith('>')) {
            const tagName = incompleteTagMatch[1];

            if (!isSelfClosingTag(tagName)) {
                const closingTag = `</${tagName}>`;

                editor.edit(editBuilder => {
                    editBuilder.insert(position, `>\n${indent}${indentUnit}\n\n${indent}${closingTag}`);
                }).then(() => {
                    const newPosition = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(newPosition, newPosition);
                });
                return;
            }
        }

        return vscode.commands.executeCommand('default:type', { text: '\n' });
    });

    context.subscriptions.push(disposable);
}

// Register Tab key handler for smart indentation
export function registerTabKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertTab', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('tab');
        }

        const position = editor.selection.active;
        const line = editor.document.lineAt(position.line);
        const lineText = line.text;

        // Only apply smart indent if the line is empty or only whitespace before cursor
        const isLineBlankSoFar = lineText.trim() === '';
        if (!isLineBlankSoFar) {
            return vscode.commands.executeCommand('tab');
        }

        const tabSize = editor.options.tabSize as number || 4;
        const useSpaces = editor.options.insertSpaces !== false;
        const indentUnit = useSpaces ? ' '.repeat(tabSize) : '\t';

        // Find the nearest non-empty line above
        let baseIndent = '';
        let prevLineText = '';
        for (let i = position.line - 1; i >= 0; i--) {
            const text = editor.document.lineAt(i).text;
            if (text.trim().length > 0) {
                const match = text.match(/^(\s*)/);
                baseIndent = match ? match[1] : '';
                prevLineText = text.trim();
                break;
            }
        }

        const inAspBlock = isInsideAspBlock(editor.document.getText(), editor.document.offsetAt(position));

        // How much whitespace is already on this line
        const currentIndent = lineText.match(/^(\s*)/)?.[1] ?? '';

        // The "correct" indent we'd suggest based on context
        let targetIndent: string;
        if (/^<%/.test(prevLineText)) {
            targetIndent = baseIndent;
        } else if (inAspBlock && VBSCRIPT_BLOCK_OPENERS.test(prevLineText)) {
            targetIndent = baseIndent + indentUnit;
        } else if (inAspBlock) {
            targetIndent = baseIndent;
        } else {
            targetIndent = baseIndent + indentUnit;
        }

        let newIndent: string;
        if (currentIndent.length < targetIndent.length) {
            // Below the correct level → snap up to it
            newIndent = targetIndent;
        } else {
            // Already at or beyond the correct level → just add one more level freely
            newIndent = currentIndent + indentUnit;
        }

        editor.edit(editBuilder => {
            // Replace whatever whitespace is already on this line before the cursor
            const replaceRange = new vscode.Range(
                new vscode.Position(position.line, 0),
                position
            );
            editBuilder.replace(replaceRange, newIndent);
        }).then(() => {
            const newPosition = new vscode.Position(position.line, newIndent.length);
            editor.selection = new vscode.Selection(newPosition, newPosition);
        });
    });

    context.subscriptions.push(disposable);
}