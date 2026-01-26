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
                // Regular tag with closing tag
                item.insertText = new vscode.SnippetString(`${tag.tag}>\n\t$0\n</${tag.tag}>`);
            }
            
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
            // Fallback to default Enter behavior
            return vscode.commands.executeCommand('default:type', { text: '\n' });
        }

        const position = editor.selection.active;
        const line = editor.document.lineAt(position.line);
        const textBefore = line.text.substring(0, position.character);
        const textAfter = line.text.substring(position.character);

        // Check if we just closed a tag: <html>|
        const justClosedTagMatch = textBefore.match(/<(\w+)([^>]*)>$/);
        
        if (justClosedTagMatch) {
            const tagName = justClosedTagMatch[1];
            
            // Check if it's not self-closing and doesn't already have a closing tag
            if (!isSelfClosingTag(tagName)) {
                const closingTag = `</${tagName}>`;
                
                // Check if closing tag already exists after cursor
                if (!textAfter.trim().startsWith(closingTag)) {
                    // Insert newline, indented line, and closing tag
                    const indent = textBefore.match(/^\s*/)?.[0] || '';
                    const tabSize = editor.options.tabSize as number || 4;
                    const useSpaces = editor.options.insertSpaces !== false;
                    const indentChar = useSpaces ? ' '.repeat(tabSize) : '\t';
                    
                    editor.edit(editBuilder => {
                        editBuilder.insert(position, `\n${indent}${indentChar}\n${indent}${closingTag}`);
                    }).then(() => {
                        // Move cursor to indented position
                        const newPosition = new vscode.Position(position.line + 1, indent.length + indentChar.length);
                        editor.selection = new vscode.Selection(newPosition, newPosition);
                    });
                    return;
                }
            }
        }

        // Check if we're after an incomplete tag: <html|
        const incompleteTagMatch = textBefore.match(/<(\w+)([^>]*)$/);
        
        if (incompleteTagMatch && !textBefore.endsWith('>')) {
            const tagName = incompleteTagMatch[1];
            
            // Check if it's not self-closing
            if (!isSelfClosingTag(tagName)) {
                const closingTag = `</${tagName}>`;
                const indent = textBefore.match(/^\s*/)?.[0] || '';
                const tabSize = editor.options.tabSize as number || 4;
                const useSpaces = editor.options.insertSpaces !== false;
                const indentChar = useSpaces ? ' '.repeat(tabSize) : '\t';
                
                editor.edit(editBuilder => {
                    // Complete the opening tag and add closing tag
                    editBuilder.insert(position, `>\n${indent}${indentChar}\n${indent}${closingTag}`);
                }).then(() => {
                    // Move cursor to indented position
                    const newPosition = new vscode.Position(position.line + 1, indent.length + indentChar.length);
                    editor.selection = new vscode.Selection(newPosition, newPosition);
                });
                return;
            }
        }

        // Default: just insert newline
        return vscode.commands.executeCommand('default:type', { text: '\n' });
    });

    context.subscriptions.push(disposable);
}