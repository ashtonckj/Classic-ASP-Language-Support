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

/**
 * Check if cursor is currently inside a VBScript string (between unescaped double quotes).
 * VBScript strings use "" as an escaped quote inside a string.
 */
function isInsideString(textBeforeCursor: string): boolean {
    let inString = false;
    for (let i = 0; i < textBeforeCursor.length; i++) {
        if (textBeforeCursor[i] === '"') {
            // Check for escaped double-quote ("") — skip both characters
            if (inString && i + 1 < textBeforeCursor.length && textBeforeCursor[i + 1] === '"') {
                i++; // skip the second quote
                continue;
            }
            inString = !inString;
        }
    }
    return inString;
}

// Keywords that only appear mid-expression and should NOT be standalone completions
const SKIP_KEYWORDS = new Set(['Then', 'To', 'In', 'Step', 'Wend', 'Loop']);

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
        const trimmedBefore = textBefore.trim();

        // Don't provide completions inside strings — e.g. stmt="|" should show nothing
        if (isInsideString(textBefore)) {
            return [];
        }

        // Check if we're accessing a method (e.g., "Response.")
        if (textBefore.match(/\b(Response|Request|Server|Session|Application)\.\s*$/i)) {
            const objectMatch = textBefore.match(/\b(Response|Request|Server|Session|Application)\.\s*$/i);
            if (objectMatch) {
                const objectName = objectMatch[1];
                return this.provideMethodCompletions(objectName);
            }
        }

        // Don't provide completions if the line is a complete closing/end keyword.
        // This prevents Enter from accidentally committing a snippet after typing e.g. "End If".
        const isCompleteEndStatement = /^(?:End\s+If|End\s+Sub|End\s+Function|End\s+Select|End\s+With|End\s+Class|End\s+Property|Next|Loop|Wend|Else)$/i.test(trimmedBefore);
        if (isCompleteEndStatement) {
            return [];
        }

        // Also suppress completions when line already ends with "Then" (If x Then|)
        // so pressing Enter just moves to next indented line without committing anything
        const endsWithThen = /\bThen\s*$/i.test(trimmedBefore);
        if (endsWithThen) {
            return [];
        }

        const completions: vscode.CompletionItem[] = [];

        // Detect if "End" is right before cursor (partial end statement like "End I")
        const isAfterEnd = /\bend\s+\w*$/i.test(trimmedBefore);

        completions.push(...this.provideAspObjectCompletions());
        completions.push(...this.provideKeywordCompletions(isAfterEnd));
        completions.push(...this.provideFunctionCompletions());

        return completions;
    }

    private provideAspObjectCompletions(): vscode.CompletionItem[] {
        return ASP_OBJECTS.map(obj => {
            const item = new vscode.CompletionItem(obj.name, vscode.CompletionItemKind.Class);
            item.detail = obj.description;
            item.documentation = new vscode.MarkdownString(
                `**${obj.name}** Object\n\n${obj.description}\n\n` +
                `**Methods/Properties:** ${obj.methods.join(', ')}`
            );
            item.sortText = '1_' + obj.name;
            item.command = {
                command: 'editor.action.triggerSuggest',
                title: 'Trigger Method Suggestions'
            };
            return item;
        });
    }

    private provideMethodCompletions(objectName: string): vscode.CompletionItem[] {
        const aspObject = ASP_OBJECTS.find(obj =>
            obj.name.toLowerCase() === objectName.toLowerCase()
        );

        if (!aspObject) {
            return [];
        }

        const completions: vscode.CompletionItem[] = [];

        for (const method of aspObject.methods) {
            const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Method);
            item.detail = `${objectName}.${method}`;

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

    private provideKeywordCompletions(isAfterEnd: boolean = false): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        for (const kw of VBSCRIPT_KEYWORDS) {
            // Skip mid-expression keywords that should never be standalone completions
            if (SKIP_KEYWORDS.has(kw.keyword)) {
                continue;
            }

            const item = new vscode.CompletionItem(kw.keyword, vscode.CompletionItemKind.Keyword);
            item.detail = kw.description;
            item.documentation = new vscode.MarkdownString(`**${kw.keyword}**\n\n${kw.description}`);

            // Don't show control structure snippets if after "End"
            if (isAfterEnd && (kw.keyword === 'If' || kw.keyword === 'Sub' || kw.keyword === 'Function' || kw.keyword === 'Select Case')) {
                item.sortText = '1_' + kw.keyword;
                items.push(item);
                continue;
            }

            // Add snippets for control structures.
            // IMPORTANT: commitCharacters is set to [] so Enter does NOT auto-commit
            // these snippets — the user must press Tab to expand them.
            if (kw.keyword === 'If') {
                item.insertText = new vscode.SnippetString('If ${1:condition} Then\n\t$0\nEnd If');
                item.kind = vscode.CompletionItemKind.Snippet;
                item.commitCharacters = [];
            } else if (kw.keyword === 'For') {
                item.insertText = new vscode.SnippetString('For ${1:i} = ${2:0} To ${3:10}\n\t$0\nNext');
                item.kind = vscode.CompletionItemKind.Snippet;
                item.commitCharacters = [];
            } else if (kw.keyword === 'For Each') {
                item.insertText = new vscode.SnippetString('For Each ${1:item} In ${2:collection}\n\t$0\nNext');
                item.kind = vscode.CompletionItemKind.Snippet;
                item.commitCharacters = [];
            } else if (kw.keyword === 'While') {
                item.insertText = new vscode.SnippetString('While ${1:condition}\n\t$0\nWend');
                item.kind = vscode.CompletionItemKind.Snippet;
                item.commitCharacters = [];
            } else if (kw.keyword === 'Do') {
                item.insertText = new vscode.SnippetString('Do\n\t$0\nLoop');
                item.kind = vscode.CompletionItemKind.Snippet;
                item.commitCharacters = [];
            } else if (kw.keyword === 'Select Case') {
                item.insertText = new vscode.SnippetString('Select Case ${1:expression}\n\tCase ${2:value}\n\t\t$0\nEnd Select');
                item.kind = vscode.CompletionItemKind.Snippet;
                item.commitCharacters = [];
            } else if (kw.keyword === 'Sub') {
                item.insertText = new vscode.SnippetString('Sub ${1:SubName}(${2:parameters})\n\t$0\nEnd Sub');
                item.kind = vscode.CompletionItemKind.Snippet;
                item.commitCharacters = [];
            } else if (kw.keyword === 'Function') {
                item.insertText = new vscode.SnippetString('Function ${1:FunctionName}(${2:parameters})\n\t$0\nEnd Function');
                item.kind = vscode.CompletionItemKind.Snippet;
                item.commitCharacters = [];
            }

            item.sortText = (item.insertText ? '0_' : '1_') + kw.keyword;
            items.push(item);
        }

        return items;
    }

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