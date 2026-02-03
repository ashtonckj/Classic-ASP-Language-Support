import * as vscode from 'vscode';
import { HTML_TAGS, isSelfClosingTag } from '../constants/htmlTags';
import { getAttributesForTag } from '../constants/htmlAttributes';
import {
    getContext,
    ContextType,
    getCurrentTagName,
    isAfterOpenBracket,
    isInsideTagForAttributes,
    getTextBeforeCursor
} from '../utils/documentHelper';

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
    });

    context.subscriptions.push(disposable);
}

// Register Enter key handler for auto-closing tags
export function registerEnterKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertLineBreak', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('default:type', { text: '\n' });
        }

        const position = editor.selection.active;
        const line = editor.document.lineAt(position.line);
        const textBefore = line.text.substring(0, position.character);
        const textAfter = line.text.substring(position.character);

        // Check if we're inside an HTML comment: <!-- | -->
        if (textBefore.trim().endsWith('<!--') && textAfter.trim().startsWith('-->')) {
            const indent = textBefore.match(/^\s*/)?.[0] || '';
            const tabSize = editor.options.tabSize as number || 4;
            const useSpaces = editor.options.insertSpaces !== false;
            const indentChar = useSpaces ? ' '.repeat(tabSize) : '\t';

            editor.edit(editBuilder => {
                // Delete the closing --> from current line
                const endOfLine = line.range.end;
                editBuilder.delete(new vscode.Range(position, endOfLine));

                // Insert: newline, indent+tab for cursor, newline, closing comment
                editBuilder.insert(position, `\n${indent}${indentChar}\n${indent}-->`);
            }).then(() => {
                // Move cursor to the indented line
                const newPosition = new vscode.Position(position.line + 1, indent.length + indentChar.length);
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

                // Check if closing tag exists anywhere after cursor (not just same line)
                const textAfterCursor = editor.document.getText(
                    new vscode.Range(position, editor.document.positionAt(editor.document.getText().length))
                );

                // Look for the closing tag (allowing for whitespace and other content)
                const closingTagRegex = new RegExp(`</${tagName}>`, 'i');
                if (closingTagRegex.test(textAfterCursor)) {
                    // Closing tag already exists
                    // Check if closing tag is on the same line immediately after cursor
                    if (textAfter.trim().startsWith(closingTag)) {
                        // Closing tag is right after cursor: <style>|</style>
                        // Insert newline, indented line for cursor, newline, then closing tag with original indent
                        const indent = textBefore.match(/^\s*/)?.[0] || '';
                        const tabSize = editor.options.tabSize as number || 4;
                        const useSpaces = editor.options.insertSpaces !== false;
                        const indentChar = useSpaces ? ' '.repeat(tabSize) : '\t';

                        editor.edit(editBuilder => {
                            // Delete the closing tag from current position
                            const endOfLine = line.range.end;
                            editBuilder.delete(new vscode.Range(position, endOfLine));

                            // Insert: newline, indent+tab for cursor, newline, closing tag
                            editBuilder.insert(position, `\n${indent}${indentChar}\n${indent}${closingTag}`);
                        }).then(() => {
                            // Move cursor to the indented line
                            const newPosition = new vscode.Position(position.line + 1, indent.length + indentChar.length);
                            editor.selection = new vscode.Selection(newPosition, newPosition);
                        });
                        return;
                    } else {
                        // Closing tag exists elsewhere, just add newline with indent
                        const indent = textBefore.match(/^\s*/)?.[0] || '';
                        const tabSize = editor.options.tabSize as number || 4;
                        const useSpaces = editor.options.insertSpaces !== false;
                        const indentChar = useSpaces ? ' '.repeat(tabSize) : '\t';

                        editor.edit(editBuilder => {
                            editBuilder.insert(position, `\n${indent}${indentChar}`);
                        }).then(() => {
                            const newPosition = new vscode.Position(position.line + 1, indent.length + indentChar.length);
                            editor.selection = new vscode.Selection(newPosition, newPosition);
                        });
                        return;
                    }
                }

                // No closing tag exists - create it
                const indent = textBefore.match(/^\s*/)?.[0] || '';
                const tabSize = editor.options.tabSize as number || 4;
                const useSpaces = editor.options.insertSpaces !== false;
                const indentChar = useSpaces ? ' '.repeat(tabSize) : '\t';

                editor.edit(editBuilder => {
                    // Insert: newline, indent+tab for cursor, newline, closing tag
                    editBuilder.insert(position, `\n${indent}${indentChar}\n${indent}${closingTag}`);
                }).then(() => {
                    // Move cursor to the first indented line (line after opening tag)
                    const newPosition = new vscode.Position(position.line + 1, indent.length + indentChar.length);
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
                const indent = textBefore.match(/^\s*/)?.[0] || '';
                const tabSize = editor.options.tabSize as number || 4;
                const useSpaces = editor.options.insertSpaces !== false;
                const indentChar = useSpaces ? ' '.repeat(tabSize) : '\t';

                editor.edit(editBuilder => {
                    editBuilder.insert(position, `>\n${indent}${indentChar}\n\n${indent}${closingTag}`);
                }).then(() => {
                    const newPosition = new vscode.Position(position.line + 1, indent.length + indentChar.length);
                    editor.selection = new vscode.Selection(newPosition, newPosition);
                });
                return;
            }
        }

        return vscode.commands.executeCommand('default:type', { text: '\n' });
    });

    context.subscriptions.push(disposable);
}