import * as vscode from 'vscode';
import { getContext, ContextType } from '../utils/documentHelper';

// Common JavaScript keywords and snippets
const JS_KEYWORDS = [
    { keyword: 'function', snippet: 'function ${1:name}($2) {\n\t$0\n}', description: 'Function declaration' },
    { keyword: 'const', snippet: 'const ${1:name} = $0;', description: 'Constant variable' },
    { keyword: 'let', snippet: 'let ${1:name} = $0;', description: 'Block-scoped variable' },
    { keyword: 'var', snippet: 'var ${1:name} = $0;', description: 'Variable declaration' },
    { keyword: 'if', snippet: 'if (${1:condition}) {\n\t$0\n}', description: 'If statement' },
    { keyword: 'else', snippet: 'else {\n\t$0\n}', description: 'Else clause' },
    { keyword: 'for', snippet: 'for (let ${1:i} = 0; ${1:i} < ${2:length}; ${1:i}++) {\n\t$0\n}', description: 'For loop' },
    { keyword: 'while', snippet: 'while (${1:condition}) {\n\t$0\n}', description: 'While loop' },
    { keyword: 'switch', snippet: 'switch (${1:expression}) {\n\tcase ${2:value}:\n\t\t$0\n\t\tbreak;\n}', description: 'Switch statement' },
    { keyword: 'try', snippet: 'try {\n\t$0\n} catch (error) {\n\t\n}', description: 'Try-catch block' },
    { keyword: 'return', snippet: 'return $0;', description: 'Return statement' },
    { keyword: 'class', snippet: 'class ${1:Name} {\n\tconstructor($2) {\n\t\t$0\n\t}\n}', description: 'Class declaration' },
];

// Common JavaScript methods and objects
const JS_GLOBALS = [
    { name: 'console.log', snippet: 'console.log($0)', description: 'Log to console' },
    { name: 'console.error', snippet: 'console.error($0)', description: 'Log error to console' },
    { name: 'console.warn', snippet: 'console.warn($0)', description: 'Log warning to console' },
    { name: 'alert', snippet: 'alert($0)', description: 'Show alert dialog' },
    { name: 'confirm', snippet: 'confirm($0)', description: 'Show confirm dialog' },
    { name: 'prompt', snippet: 'prompt($0)', description: 'Show prompt dialog' },
    { name: 'parseInt', snippet: 'parseInt($0)', description: 'Parse integer' },
    { name: 'parseFloat', snippet: 'parseFloat($0)', description: 'Parse float' },
    { name: 'setTimeout', snippet: 'setTimeout(() => {\n\t$0\n}, ${1:1000})', description: 'Set timeout' },
    { name: 'setInterval', snippet: 'setInterval(() => {\n\t$0\n}, ${1:1000})', description: 'Set interval' },
    { name: 'document.getElementById', snippet: 'document.getElementById(\'$0\')', description: 'Get element by ID' },
    { name: 'document.querySelector', snippet: 'document.querySelector(\'$0\')', description: 'Query selector' },
    { name: 'document.querySelectorAll', snippet: 'document.querySelectorAll(\'$0\')', description: 'Query selector all' },
    { name: 'document.createElement', snippet: 'document.createElement(\'$0\')', description: 'Create element' },
    { name: 'addEventListener', snippet: 'addEventListener(\'${1:click}\', ($2) => {\n\t$0\n})', description: 'Add event listener' },
    { name: 'fetch', snippet: 'fetch(\'$1\')\n\t.then(response => response.json())\n\t.then(data => {\n\t\t$0\n})', description: 'Fetch API' },
];

export class JsCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const config = vscode.workspace.getConfiguration('aspLanguageSupport');
        if (!config.get<boolean>('enableJSCompletion', true)) {
            return [];
        }

        const docContext = getContext(document, position);

        // Only provide JS completions inside <script> tags
        if (docContext !== ContextType.JAVASCRIPT) {
            return [];
        }

        const lineText = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        // Only provide completions if user has typed something (not just empty line)
        const wordMatch = textBefore.match(/[\w\.]+$/);
        if (!wordMatch || wordMatch[0].length === 0) {
            return [];
        }

        // Check if it's accessing object methods/properties (e.g., "element.a")
        const objectAccessMatch = textBefore.match(/([\w]+)\.([\w]*)$/);
        if (objectAccessMatch) {
            const objectName = objectAccessMatch[1];
            const partialMethod = objectAccessMatch[2];

            // Provide context-specific completions based on object
            if (objectName === 'document') {
                return this.provideDocumentCompletions();
            } else if (objectName === 'console') {
                return this.provideConsoleCompletions();
            }
            // For other objects, return generic completions
            return [];
        }

        const completions: vscode.CompletionItem[] = [];

        // Add keywords only if typing word characters
        if (wordMatch && wordMatch[0].length >= 2) {
            completions.push(...this.provideKeywordCompletions());
            completions.push(...this.provideGlobalCompletions());
        }

        return completions;
    }

    private provideDocumentCompletions(): vscode.CompletionItem[] {
        const documentMethods = [
            { name: 'getElementById', snippet: 'getElementById(\'$0\')', description: 'Get element by ID' },
            { name: 'querySelector', snippet: 'querySelector(\'$0\')', description: 'Query selector' },
            { name: 'querySelectorAll', snippet: 'querySelectorAll(\'$0\')', description: 'Query selector all' },
            { name: 'createElement', snippet: 'createElement(\'$0\')', description: 'Create element' },
            { name: 'addEventListener', snippet: 'addEventListener(\'${1:click}\', ($2) => {\n\t$0\n})', description: 'Add event listener' },
        ];

        return documentMethods.map(method => {
            const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Method);
            item.detail = method.description;
            item.documentation = new vscode.MarkdownString(`**document.${method.name}**\n\n${method.description}`);
            item.insertText = new vscode.SnippetString(method.snippet);
            item.sortText = '0_' + method.name;
            return item;
        });
    }

    private provideConsoleCompletions(): vscode.CompletionItem[] {
        const consoleMethods = [
            { name: 'log', snippet: 'log($0)', description: 'Log to console' },
            { name: 'error', snippet: 'error($0)', description: 'Log error to console' },
            { name: 'warn', snippet: 'warn($0)', description: 'Log warning to console' },
        ];

        return consoleMethods.map(method => {
            const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Method);
            item.detail = method.description;
            item.documentation = new vscode.MarkdownString(`**console.${method.name}**\n\n${method.description}`);
            item.insertText = new vscode.SnippetString(method.snippet);
            item.sortText = '0_' + method.name;
            return item;
        });
    }

    private provideKeywordCompletions(): vscode.CompletionItem[] {
        return JS_KEYWORDS.map(kw => {
            const item = new vscode.CompletionItem(kw.keyword, vscode.CompletionItemKind.Keyword);
            item.detail = kw.description;
            item.documentation = new vscode.MarkdownString(`**${kw.keyword}**\n\n${kw.description}`);
            item.insertText = new vscode.SnippetString(kw.snippet);
            // Multi-line snippets must use Snippet kind so they sort above
            // VS Code's built-in "previously used word" suggestions
            if (kw.snippet.includes('\n')) {
                item.kind = vscode.CompletionItemKind.Snippet;
            }
            item.sortText = '0_' + kw.keyword;
            return item;
        });
    }

    private provideGlobalCompletions(): vscode.CompletionItem[] {
        return JS_GLOBALS.map(global => {
            const item = new vscode.CompletionItem(global.name, vscode.CompletionItemKind.Function);
            item.detail = global.description;
            item.documentation = new vscode.MarkdownString(`**${global.name}**\n\n${global.description}`);
            item.insertText = new vscode.SnippetString(global.snippet);
            item.sortText = '0_' + global.name;
            return item;
        });
    }
}