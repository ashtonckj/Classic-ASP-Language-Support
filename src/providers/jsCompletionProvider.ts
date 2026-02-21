/**
 * jsCompletionProvider.ts
 * Provides JavaScript IntelliSense inside <script> blocks in .asp files.
 */

import * as vscode from 'vscode';
import { getContext, ContextType } from '../utils/documentHelper';
import { JS_KEYWORDS } from '../constants/jsKeywords';
import {
    JS_GLOBAL_OBJECTS,
    CONSOLE_METHODS,
    DOCUMENT_METHODS,
    ELEMENT_METHODS,
    WINDOW_METHODS,
    JS_GLOBAL_FUNCTIONS,
    ARRAY_METHODS,
    STRING_METHODS,
    OBJECT_METHODS,
    DOM_EVENTS
} from '../constants/jsGlobals';

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
        if (docContext !== ContextType.JAVASCRIPT) {
            return [];
        }

        const lineText = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        // ── Object member access (e.g. document., console., element.) ─────────
        const objectAccessMatch = textBefore.match(/([\w]+)\.([\w]*)$/);
        if (objectAccessMatch) {
            const objectName = objectAccessMatch[1];

            switch (objectName) {
                case 'document':
                    return this.buildItems(DOCUMENT_METHODS, vscode.CompletionItemKind.Method, 'document');
                case 'console':
                    return this.buildItems(CONSOLE_METHODS, vscode.CompletionItemKind.Method, 'console');
                case 'window':
                    return this.buildItems(WINDOW_METHODS, vscode.CompletionItemKind.Method, 'window');
                case 'Math':
                    return this.buildItems(
                        JS_GLOBAL_FUNCTIONS.filter(f => f.name.startsWith('Math.')).map(f => ({ ...f, name: f.name.replace('Math.', '') })),
                        vscode.CompletionItemKind.Function, 'Math'
                    );
                case 'JSON':
                    return this.buildItems(
                        JS_GLOBAL_FUNCTIONS.filter(f => f.name.startsWith('JSON.')).map(f => ({ ...f, name: f.name.replace('JSON.', '') })),
                        vscode.CompletionItemKind.Function, 'JSON'
                    );
                case 'Object':
                    return this.buildItems(
                        OBJECT_METHODS.filter(f => f.name.startsWith('Object.')).map(f => ({ ...f, name: f.name.replace('Object.', '') })),
                        vscode.CompletionItemKind.Function, 'Object'
                    );
                case 'Array':
                    return this.buildItems(
                        [{ name: 'from', snippet: 'from($0)', description: 'Create array from iterable' }, { name: 'isArray', snippet: 'isArray($0)', description: 'Check if value is array' }],
                        vscode.CompletionItemKind.Function, 'Array'
                    );
                case 'Promise':
                    return this.buildItems(
                        JS_GLOBAL_FUNCTIONS.filter(f => f.name.startsWith('Promise.')).map(f => ({ ...f, name: f.name.replace('Promise.', '') })),
                        vscode.CompletionItemKind.Function, 'Promise'
                    );
                case 'localStorage':
                case 'sessionStorage':
                    return this.buildStorageItems(objectName);
                case 'location':
                    return this.buildLocationItems();
                case 'history':
                    return this.buildHistoryItems();
                case 'classList':
                    return this.buildClassListItems();
                case 'style':
                    return this.buildStyleItems();
                default:
                    // Generic variable — return element methods as best guess
                    return this.buildItems(ELEMENT_METHODS, vscode.CompletionItemKind.Method, objectName);
            }
        }

        // ── addEventListener string argument — suggest event names ─────────────
        const eventListenerMatch = textBefore.match(/addEventListener\s*\(\s*['"]([^'"]*)?$/);
        if (eventListenerMatch) {
            return DOM_EVENTS.map(event => {
                const item = new vscode.CompletionItem(event.name, vscode.CompletionItemKind.EnumMember);
                item.detail = event.description;
                item.insertText = event.name;
                item.sortText = '0_' + event.name;
                return item;
            });
        }

        // ── General completions — keywords + global objects + global functions ──
        const wordMatch = textBefore.match(/[\w\.]+$/);
        if (!wordMatch || wordMatch[0].length === 0) {
            return [];
        }

        const completions: vscode.CompletionItem[] = [];

        // Keywords and snippets
        completions.push(...this.buildKeywordItems());

        // Top-level global objects (document, window, console, Math etc.)
        for (const obj of JS_GLOBAL_OBJECTS) {
            const item = new vscode.CompletionItem(obj.name, vscode.CompletionItemKind.Module);
            item.detail = obj.description;
            item.documentation = new vscode.MarkdownString(`**${obj.name}**\n\n${obj.description}`);
            item.insertText = new vscode.SnippetString(obj.snippet);
            item.sortText = '1_' + obj.name; // Sort after keywords
            completions.push(item);
        }

        // Global functions (parseInt, JSON.stringify, fetch etc.)
        completions.push(...this.buildItems(JS_GLOBAL_FUNCTIONS, vscode.CompletionItemKind.Function, ''));

        // Common window functions available without window. prefix
        completions.push(...this.buildItems(
            WINDOW_METHODS.filter(m => ['alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'fetch'].includes(m.name)),
            vscode.CompletionItemKind.Function, ''
        ));

        return completions;
    }

    // ── Builders ───────────────────────────────────────────────────────────────

    private buildItems(
        items: Array<{ name: string; snippet: string; description: string }>,
        kind: vscode.CompletionItemKind,
        parentName: string
    ): vscode.CompletionItem[] {
        return items.map(m => {
            const item = new vscode.CompletionItem(m.name, kind);
            item.detail = m.description;
            item.documentation = new vscode.MarkdownString(
                parentName ? `**${parentName}.${m.name}**\n\n${m.description}` : `**${m.name}**\n\n${m.description}`
            );
            item.insertText = new vscode.SnippetString(m.snippet);
            item.sortText = '0_' + m.name;
            return item;
        });
    }

    private buildKeywordItems(): vscode.CompletionItem[] {
        return JS_KEYWORDS.map(kw => {
            const item = new vscode.CompletionItem(kw.keyword, vscode.CompletionItemKind.Keyword);
            item.detail = kw.description;
            item.documentation = new vscode.MarkdownString(`**${kw.keyword}**\n\n${kw.description}`);
            item.insertText = new vscode.SnippetString(kw.snippet);
            if (kw.snippet.includes('\n')) {
                item.kind = vscode.CompletionItemKind.Snippet;
            }
            item.sortText = '0_' + kw.keyword;
            return item;
        });
    }

    private buildStorageItems(storageName: string): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'getItem', snippet: "getItem('$0')", description: 'Get stored value' },
            { name: 'setItem', snippet: "setItem('${1:key}', '${2:value}')", description: 'Set stored value' },
            { name: 'removeItem', snippet: "removeItem('$0')", description: 'Remove stored value' },
            { name: 'clear', snippet: 'clear()', description: 'Clear all stored values' },
            { name: 'key', snippet: 'key(${1:index})', description: 'Get key at index' },
            { name: 'length', snippet: 'length', description: 'Number of stored items' },
        ], vscode.CompletionItemKind.Method, storageName);
    }

    private buildLocationItems(): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'href', snippet: "href = '$0'", description: 'Full URL' },
            { name: 'reload', snippet: 'reload()', description: 'Reload the page' },
            { name: 'replace', snippet: "replace('$0')", description: 'Replace current page in history' },
            { name: 'assign', snippet: "assign('$0')", description: 'Load new document' },
            { name: 'pathname', snippet: 'pathname', description: 'URL path' },
            { name: 'search', snippet: 'search', description: 'Query string' },
            { name: 'hash', snippet: 'hash', description: 'URL hash' },
            { name: 'hostname', snippet: 'hostname', description: 'Hostname' },
            { name: 'origin', snippet: 'origin', description: 'Origin' },
            { name: 'protocol', snippet: 'protocol', description: 'Protocol (http:, https:)' },
        ], vscode.CompletionItemKind.Property, 'location');
    }

    private buildHistoryItems(): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'back', snippet: 'back()', description: 'Go back' },
            { name: 'forward', snippet: 'forward()', description: 'Go forward' },
            { name: 'go', snippet: 'go(${1:-1})', description: 'Go to history entry' },
            { name: 'pushState', snippet: "pushState(${1:{}}, '', '${2:url}')", description: 'Push history state' },
            { name: 'replaceState', snippet: "replaceState(${1:{}}, '', '${2:url}')", description: 'Replace history state' },
            { name: 'length', snippet: 'length', description: 'History length' },
            { name: 'state', snippet: 'state', description: 'Current state object' },
        ], vscode.CompletionItemKind.Method, 'history');
    }

    private buildClassListItems(): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'add', snippet: "add('$0')", description: 'Add class' },
            { name: 'remove', snippet: "remove('$0')", description: 'Remove class' },
            { name: 'toggle', snippet: "toggle('$0')", description: 'Toggle class' },
            { name: 'contains', snippet: "contains('$0')", description: 'Check if class exists' },
            { name: 'replace', snippet: "replace('${1:old}', '${2:new}')", description: 'Replace class' },
            { name: 'item', snippet: 'item(${1:index})', description: 'Get class at index' },
            { name: 'length', snippet: 'length', description: 'Number of classes' },
        ], vscode.CompletionItemKind.Method, 'classList');
    }

    private buildStyleItems(): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'display', snippet: "display = '${1:none}'", description: 'Display property' },
            { name: 'visibility', snippet: "visibility = '${1:hidden}'", description: 'Visibility property' },
            { name: 'color', snippet: "color = '$0'", description: 'Text color' },
            { name: 'backgroundColor', snippet: "backgroundColor = '$0'", description: 'Background color' },
            { name: 'fontSize', snippet: "fontSize = '$0'", description: 'Font size' },
            { name: 'fontWeight', snippet: "fontWeight = '$0'", description: 'Font weight' },
            { name: 'width', snippet: "width = '$0'", description: 'Width' },
            { name: 'height', snippet: "height = '$0'", description: 'Height' },
            { name: 'margin', snippet: "margin = '$0'", description: 'Margin' },
            { name: 'padding', snippet: "padding = '$0'", description: 'Padding' },
            { name: 'border', snippet: "border = '$0'", description: 'Border' },
            { name: 'borderRadius', snippet: "borderRadius = '$0'", description: 'Border radius' },
            { name: 'position', snippet: "position = '${1:absolute}'", description: 'Position' },
            { name: 'top', snippet: "top = '$0'", description: 'Top position' },
            { name: 'left', snippet: "left = '$0'", description: 'Left position' },
            { name: 'right', snippet: "right = '$0'", description: 'Right position' },
            { name: 'bottom', snippet: "bottom = '$0'", description: 'Bottom position' },
            { name: 'zIndex', snippet: "zIndex = '$0'", description: 'Z-index' },
            { name: 'opacity', snippet: "opacity = '$0'", description: 'Opacity' },
            { name: 'overflow', snippet: "overflow = '${1:hidden}'", description: 'Overflow' },
            { name: 'transform', snippet: "transform = '$0'", description: 'Transform' },
            { name: 'transition', snippet: "transition = '$0'", description: 'Transition' },
            { name: 'cursor', snippet: "cursor = '${1:pointer}'", description: 'Cursor' },
            { name: 'textAlign', snippet: "textAlign = '${1:center}'", description: 'Text alignment' },
            { name: 'lineHeight', snippet: "lineHeight = '$0'", description: 'Line height' },
            { name: 'cssText', snippet: "cssText = '$0'", description: 'Set all styles as string' },
        ], vscode.CompletionItemKind.Property, 'style');
    }
}