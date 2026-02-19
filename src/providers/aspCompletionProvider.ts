import * as vscode from 'vscode';
import { ASP_OBJECTS, VBSCRIPT_KEYWORDS, VBSCRIPT_FUNCTIONS } from '../constants/aspKeywords';

/**
 * Check if cursor is inside <% %> block
 */
function isInsideAspBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
    const textBeforeCursor = document.getText(
        new vscode.Range(new vscode.Position(0, 0), position)
    );

    const openTags = (textBeforeCursor.match(/<%/g) || []).length;
    const closeTags = (textBeforeCursor.match(/%>/g) || []).length;

    return openTags > closeTags;
}

/**
 * Get text before cursor on current line
 */
function getTextBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    const lineText = document.lineAt(position.line).text;
    return lineText.substring(0, position.character);
}

export class AspCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const config = vscode.workspace.getConfiguration('aspLanguageSupport');
        if (!config.get<boolean>('enableAspCompletion', true)) {
            return [];
        }

        // Only provide ASP completions inside <% %> blocks
        if (!isInsideAspBlock(document, position)) {
            return [];
        }

        const textBefore = getTextBeforeCursor(document, position);

        // Check if we're accessing a method (e.g., "Response.")
        // IMPORTANT: Return ONLY methods, not all completions!
        if (textBefore.match(/\b(Response|Request|Server|Session|Application)\.\s*$/i)) {
            const objectMatch = textBefore.match(/\b(Response|Request|Server|Session|Application)\.\s*$/i);
            if (objectMatch) {
                const objectName = objectMatch[1];
                console.log(`✅ Detected "${objectName}." - returning ONLY methods`);
                return this.provideMethodCompletions(objectName);
            }
        }

        // Don't provide completions if the line is a complete End-block statement.
        // This prevents Enter from accidentally committing a snippet after typing e.g. "End If".
        const trimmedBefore = textBefore.trim();
        const isCompleteEndStatement = /^(?:End\s+If|End\s+Sub|End\s+Function|End\s+Select|End\s+With|End\s+Class|End\s+Property|Next|Loop|Wend)$/i.test(trimmedBefore);
        if (isCompleteEndStatement) {
            return [];
        }

        // Otherwise, provide all ASP completions
        const completions: vscode.CompletionItem[] = [];

        // Detect if "End" is right before cursor (partial end statement like "End I")
        const isAfterEnd = /\bend\s+i?f?$/i.test(trimmedBefore);

        // Provide ASP objects, keywords, and functions
        completions.push(...this.provideAspObjectCompletions());
        completions.push(...this.provideKeywordCompletions(isAfterEnd));
        completions.push(...this.provideFunctionCompletions());

        return completions;
    }

    // Provide ASP object completions (Response, Request, etc.)
    private provideAspObjectCompletions(): vscode.CompletionItem[] {
        return ASP_OBJECTS.map(obj => {
            const item = new vscode.CompletionItem(obj.name, vscode.CompletionItemKind.Class);
            item.detail = obj.description;
            item.documentation = new vscode.MarkdownString(
                `**${obj.name}** Object\n\n${obj.description}\n\n` +
                `**Methods/Properties:** ${obj.methods.join(', ')}`
            );

            item.sortText = '1_' + obj.name;

            // Trigger method suggestions after inserting object
            item.command = {
                command: 'editor.action.triggerSuggest',
                title: 'Trigger Method Suggestions'
            };

            return item;
        });
    }

    // Provide method completions for ASP objects
    private provideMethodCompletions(objectName: string): vscode.CompletionItem[] {
        const aspObject = ASP_OBJECTS.find(obj =>
            obj.name.toLowerCase() === objectName.toLowerCase()
        );

        if (!aspObject) {
            return [];
        }

        const completions: vscode.CompletionItem[] = [];

        // Add methods
        for (const method of aspObject.methods) {
            const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Method);
            item.detail = `${objectName}.${method}`;

            // Add specific documentation and snippets for common methods
            switch (method) {
                case 'Write':
                    item.documentation = 'Write output to the client';
                    item.insertText = new vscode.SnippetString('Write($0)');
                    break;
                case 'Redirect':
                    item.documentation = 'Redirect to another URL';
                    item.insertText = new vscode.SnippetString('Redirect("$0")');
                    break;
                case 'Form':
                    item.documentation = 'Get form data';
                    item.insertText = new vscode.SnippetString('Form("$0")');
                    break;
                case 'QueryString':
                    item.documentation = 'Get query string parameter';
                    item.insertText = new vscode.SnippetString('QueryString("$0")');
                    break;
                case 'CreateObject':
                    item.documentation = 'Create a COM object';
                    item.insertText = new vscode.SnippetString('CreateObject("$0")');
                    break;
                case 'MapPath':
                    item.documentation = 'Map virtual path to physical path';
                    item.insertText = new vscode.SnippetString('MapPath("$0")');
                    break;
                case 'HTMLEncode':
                    item.documentation = 'Encode HTML special characters';
                    item.insertText = new vscode.SnippetString('HTMLEncode($0)');
                    break;
                case 'URLEncode':
                    item.documentation = 'Encode URL special characters';
                    item.insertText = new vscode.SnippetString('URLEncode($0)');
                    break;
                default:
                    item.documentation = `${objectName}.${method} method`;
                    item.insertText = method;
            }

            item.sortText = '0_' + method;

            completions.push(item);
        }

        return completions;
    }

    // Provide VBScript keyword completions
    private provideKeywordCompletions(isAfterEnd: boolean = false): vscode.CompletionItem[] {
        return VBSCRIPT_KEYWORDS.map(kw => {
            const item = new vscode.CompletionItem(kw.keyword, vscode.CompletionItemKind.Keyword);
            item.detail = kw.description;
            item.documentation = new vscode.MarkdownString(`**${kw.keyword}**\n\n${kw.description}`);

            // Don't show control structure snippets if after "End"
            if (isAfterEnd && (kw.keyword === 'If' || kw.keyword === 'Sub' || kw.keyword === 'Function' || kw.keyword === 'Select Case')) {
                item.sortText = '1_' + kw.keyword;
                return item;
            }

            // Add snippets for control structures
            if (kw.keyword === 'If') {
                item.insertText = new vscode.SnippetString('If ${1:condition} Then\n\t$0\nEnd If');
                item.kind = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'For') {
                item.insertText = new vscode.SnippetString('For ${1:i} = ${2:0} To ${3:10}\n\t$0\nNext');
                item.kind = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'For Each') {
                item.insertText = new vscode.SnippetString('For Each ${1:item} In ${2:collection}\n\t$0\nNext');
                item.kind = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'While') {
                item.insertText = new vscode.SnippetString('While ${1:condition}\n\t$0\nWend');
                item.kind = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'Do') {
                item.insertText = new vscode.SnippetString('Do\n\t$0\nLoop');
                item.kind = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'Select Case') {
                item.insertText = new vscode.SnippetString('Select Case ${1:expression}\n\tCase ${2:value}\n\t\t$0\nEnd Select');
                item.kind = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'Sub') {
                item.insertText = new vscode.SnippetString('Sub ${1:SubName}(${2:parameters})\n\t$0\nEnd Sub');
                item.kind = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'Function') {
                item.insertText = new vscode.SnippetString('Function ${1:FunctionName}(${2:parameters})\n\t$0\nEnd Function');
                item.kind = vscode.CompletionItemKind.Snippet;
            }

            // Snippets sort at "0_", plain keywords at "1_"
            item.sortText = (item.insertText ? '0_' : '1_') + kw.keyword;

            return item;
        });
    }

    // Provide VBScript function completions
    private provideFunctionCompletions(): vscode.CompletionItem[] {
        return VBSCRIPT_FUNCTIONS.map(func => {
            const item = new vscode.CompletionItem(func, vscode.CompletionItemKind.Function);
            item.detail = `VBScript function`;
            item.documentation = new vscode.MarkdownString(`**${func}()** - VBScript built-in function`);
            item.insertText = new vscode.SnippetString(`${func}($0)`);
            item.sortText = '0_' + func;
            return item;
        });
    }
}