/**
 * jsCompletionProvider.ts
 * Provides JavaScript IntelliSense inside <script> blocks in .asp files.
 */

import * as vscode from 'vscode';
import { getContext, ContextType } from '../utils/documentHelper';
import { extractSymbols } from './includeProvider';
import { JS_KEYWORDS } from '../constants/jsKeywords';
import {
    JS_GLOBAL_OBJECTS,
    CONSOLE_METHODS,
    DOCUMENT_METHODS,
    ELEMENT_METHODS,
    WINDOW_METHODS,
    NAVIGATOR_METHODS,
    SCREEN_METHODS,
    PERFORMANCE_METHODS,
    DATE_METHODS,
    NUMBER_METHODS,
    MATH_METHODS,
    MAP_METHODS,
    SET_METHODS,
    PROMISE_METHODS,
    REGEXP_METHODS,
    URL_SEARCH_PARAMS_METHODS,
    FORM_DATA_METHODS,
    RESPONSE_METHODS,
    MUTATION_OBSERVER_METHODS,
    INTERSECTION_OBSERVER_METHODS,
    EVENT_METHODS,
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
                case 'navigator':
                    return this.buildItems(NAVIGATOR_METHODS, vscode.CompletionItemKind.Property, 'navigator');
                case 'screen':
                    return this.buildItems(SCREEN_METHODS, vscode.CompletionItemKind.Property, 'screen');
                case 'performance':
                    return this.buildItems(PERFORMANCE_METHODS, vscode.CompletionItemKind.Method, 'performance');
                case 'Math':
                    return this.buildItems(MATH_METHODS, vscode.CompletionItemKind.Function, 'Math');
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
                        JS_GLOBAL_FUNCTIONS.filter(f => f.name.startsWith('Array.')).map(f => ({ ...f, name: f.name.replace('Array.', '') })),
                        vscode.CompletionItemKind.Function, 'Array'
                    );
                case 'Number':
                    return this.buildItems(
                        NUMBER_METHODS.filter(f => f.name.startsWith('Number.')).map(f => ({ ...f, name: f.name.replace('Number.', '') })),
                        vscode.CompletionItemKind.Function, 'Number'
                    );
                case 'String':
                    return this.buildItems(
                        JS_GLOBAL_FUNCTIONS.filter(f => f.name.startsWith('String.')).map(f => ({ ...f, name: f.name.replace('String.', '') })),
                        vscode.CompletionItemKind.Function, 'String'
                    );
                case 'Date':
                    return this.buildItems(
                        DATE_METHODS.filter(f => f.name.startsWith('Date.')).map(f => ({ ...f, name: f.name.replace('Date.', '') })),
                        vscode.CompletionItemKind.Function, 'Date'
                    );
                case 'Promise':
                    return this.buildItems(
                        PROMISE_METHODS.filter(f => f.name.startsWith('Promise.')).map(f => ({ ...f, name: f.name.replace('Promise.', '') })),
                        vscode.CompletionItemKind.Function, 'Promise'
                    );
                case 'Reflect':
                    return this.buildReflectItems();
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
                case 'dataset':
                    return []; // dynamic keys — no useful static completions
                case 'event':
                    return this.buildItems(EVENT_METHODS, vscode.CompletionItemKind.Property, 'event');
                // Instance methods triggered on typed variables
                // These are heuristic: we can't know the type of an arbitrary variable,
                // so we return the most commonly needed group based on name hints.
                default:
                    // Check if name hints at a specific type
                    if (/map$/i.test(objectName)) {
                        return this.buildItems(MAP_METHODS, vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/set$/i.test(objectName)) {
                        return this.buildItems(SET_METHODS, vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/promise|async|result|fetch/i.test(objectName)) {
                        return this.buildItems(PROMISE_METHODS, vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/regexp|regex|pattern/i.test(objectName)) {
                        return this.buildItems(REGEXP_METHODS, vscode.CompletionItemKind.Property, objectName);
                    }
                    if (/params|query|search/i.test(objectName)) {
                        return this.buildItems(URL_SEARCH_PARAMS_METHODS, vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/form(data)?/i.test(objectName)) {
                        return this.buildItems(FORM_DATA_METHODS, vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/response|res$/i.test(objectName)) {
                        return this.buildItems(RESPONSE_METHODS, vscode.CompletionItemKind.Property, objectName);
                    }
                    if (/observer/i.test(objectName)) {
                        return this.buildItems(MUTATION_OBSERVER_METHODS, vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/arr|list|items|elements|nodes/i.test(objectName)) {
                        return this.buildItems(ARRAY_METHODS, vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/str|text|name|title|label|msg|message/i.test(objectName)) {
                        return this.buildItems(STRING_METHODS, vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/date|time/i.test(objectName)) {
                        return this.buildItems(DATE_METHODS.filter(m => !m.name.startsWith('Date.')), vscode.CompletionItemKind.Method, objectName);
                    }
                    if (/num|count|total|index|id$/i.test(objectName)) {
                        return this.buildItems(NUMBER_METHODS.filter(m => !m.name.startsWith('Number.')), vscode.CompletionItemKind.Method, objectName);
                    }
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
            item.sortText = '1_' + obj.name;
            completions.push(item);
        }

        // Global functions (parseInt, JSON.stringify, fetch etc.)
        completions.push(...this.buildItems(JS_GLOBAL_FUNCTIONS, vscode.CompletionItemKind.Function, ''));

        // Common window functions available without window. prefix
        completions.push(...this.buildItems(
            WINDOW_METHODS.filter(m => [
                'alert', 'confirm', 'prompt',
                'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
                'requestAnimationFrame', 'cancelAnimationFrame',
                'requestIdleCallback', 'cancelIdleCallback',
                'fetch', 'atob', 'btoa',
                'structuredClone', 'queueMicrotask',
                'getComputedStyle', 'matchMedia'
            ].includes(m.name)),
            vscode.CompletionItemKind.Function, ''
        ));

        // ── User-defined JS functions and variables from <script> blocks ──────
        // Parse the current document for function declarations and var/let/const
        // so users get completions for their own code inside <script> blocks.
        const docText    = document.getText();
        const userSymbols = extractUserJsSymbols(docText);

        for (const fn of userSymbols.functions) {
            const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
            item.detail    = 'JS function (this file)';
            item.sortText  = '2_' + fn;
            completions.push(item);
        }
        for (const v of userSymbols.variables) {
            const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable);
            item.detail   = 'JS variable (this file)';
            item.sortText = '2_' + v;
            completions.push(item);
        }

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
            { name: 'getItem', snippet: "getItem('$0')", description: 'Get stored value by key' },
            { name: 'setItem', snippet: "setItem('${1:key}', '${2:value}')", description: 'Set stored key-value pair' },
            { name: 'removeItem', snippet: "removeItem('$0')", description: 'Remove stored value by key' },
            { name: 'clear', snippet: 'clear()', description: 'Clear all stored values' },
            { name: 'key', snippet: 'key(${1:index})', description: 'Get key name at index' },
            { name: 'length', snippet: 'length', description: 'Number of stored items' },
        ], vscode.CompletionItemKind.Method, storageName);
    }

    private buildLocationItems(): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'href', snippet: "href = '$0'", description: 'Full URL (setting navigates)' },
            { name: 'reload', snippet: 'reload()', description: 'Reload the current page' },
            { name: 'replace', snippet: "replace('$0')", description: 'Replace current entry in history and navigate' },
            { name: 'assign', snippet: "assign('$0')", description: 'Navigate to URL (adds history entry)' },
            { name: 'toString', snippet: 'toString()', description: 'Return full URL as string' },
            { name: 'pathname', snippet: 'pathname', description: 'URL path (e.g. "/page/slug")' },
            { name: 'search', snippet: 'search', description: 'Query string including ? (e.g. "?id=1")' },
            { name: 'hash', snippet: 'hash', description: 'URL hash including # (e.g. "#section")' },
            { name: 'hostname', snippet: 'hostname', description: 'Hostname without port (e.g. "example.com")' },
            { name: 'host', snippet: 'host', description: 'Hostname with port if non-default' },
            { name: 'port', snippet: 'port', description: 'Port number as string' },
            { name: 'origin', snippet: 'origin', description: 'Origin: scheme + host + port' },
            { name: 'protocol', snippet: 'protocol', description: 'Protocol with colon (e.g. "https:")' },
            { name: 'username', snippet: 'username', description: 'Username before @ in URL' },
            { name: 'password', snippet: 'password', description: 'Password before @ in URL' },
            { name: 'ancestorOrigins', snippet: 'ancestorOrigins', description: 'Ordered list of ancestor frame origins' },
        ], vscode.CompletionItemKind.Property, 'location');
    }

    private buildHistoryItems(): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'back', snippet: 'back()', description: 'Go one step back' },
            { name: 'forward', snippet: 'forward()', description: 'Go one step forward' },
            { name: 'go', snippet: 'go(${1:-1})', description: 'Go N steps in history (negative = back)' },
            { name: 'pushState', snippet: "pushState(${1:{}}, '', '${2:url}')", description: 'Add history entry without navigating' },
            { name: 'replaceState', snippet: "replaceState(${1:{}}, '', '${2:url}')", description: 'Replace current history entry without navigating' },
            { name: 'length', snippet: 'length', description: 'Number of entries in the session history' },
            { name: 'state', snippet: 'state', description: 'Current history state object' },
            { name: 'scrollRestoration', snippet: "scrollRestoration = '${1:manual}'", description: 'Control scroll restoration: auto | manual' },
        ], vscode.CompletionItemKind.Method, 'history');
    }

    private buildClassListItems(): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'add', snippet: "add('$0')", description: 'Add one or more classes' },
            { name: 'remove', snippet: "remove('$0')", description: 'Remove one or more classes' },
            { name: 'toggle', snippet: "toggle('$0')", description: 'Toggle class; optional second arg forces state' },
            { name: 'contains', snippet: "contains('$0')", description: 'Check if class exists' },
            { name: 'replace', snippet: "replace('${1:oldClass}', '${2:newClass}')", description: 'Replace a class with another' },
            { name: 'item', snippet: 'item(${1:index})', description: 'Get class at index' },
            { name: 'forEach', snippet: 'forEach((${1:cls}) => {\n\t$0\n})', description: 'Iterate over all classes' },
            { name: 'values', snippet: 'values()', description: 'Iterator of class strings' },
            { name: 'entries', snippet: 'entries()', description: 'Iterator of [index, class] pairs' },
            { name: 'keys', snippet: 'keys()', description: 'Iterator of class indices' },
            { name: 'length', snippet: 'length', description: 'Number of classes' },
            { name: 'value', snippet: 'value', description: 'Space-separated class string' },
        ], vscode.CompletionItemKind.Method, 'classList');
    }

    private buildStyleItems(): vscode.CompletionItem[] {
        return this.buildItems([
            // Display & Layout
            { name: 'display', snippet: "display = '${1:none}'", description: 'Display: none|block|flex|grid|inline...' },
            { name: 'visibility', snippet: "visibility = '${1:hidden}'", description: 'Visibility: visible|hidden|collapse' },
            { name: 'opacity', snippet: "opacity = '${1:0}'", description: 'Opacity: 0 (transparent) – 1 (opaque)' },
            { name: 'overflow', snippet: "overflow = '${1:hidden}'", description: 'Overflow: visible|hidden|auto|scroll' },
            { name: 'overflowX', snippet: "overflowX = '${1:hidden}'", description: 'Horizontal overflow' },
            { name: 'overflowY', snippet: "overflowY = '${1:auto}'", description: 'Vertical overflow' },
            // Box Model
            { name: 'width', snippet: "width = '${1:100%}'", description: 'Width (px, %, em, etc.)' },
            { name: 'height', snippet: "height = '${1:100px}'", description: 'Height' },
            { name: 'minWidth', snippet: "minWidth = '${1:0}'", description: 'Minimum width' },
            { name: 'maxWidth', snippet: "maxWidth = '${1:100%}'", description: 'Maximum width' },
            { name: 'minHeight', snippet: "minHeight = '${1:0}'", description: 'Minimum height' },
            { name: 'maxHeight', snippet: "maxHeight = '${1:none}'", description: 'Maximum height' },
            { name: 'margin', snippet: "margin = '${1:0}'", description: 'Shorthand margin' },
            { name: 'marginTop', snippet: "marginTop = '${1:0}'", description: 'Top margin' },
            { name: 'marginRight', snippet: "marginRight = '${1:0}'", description: 'Right margin' },
            { name: 'marginBottom', snippet: "marginBottom = '${1:0}'", description: 'Bottom margin' },
            { name: 'marginLeft', snippet: "marginLeft = '${1:0}'", description: 'Left margin' },
            { name: 'padding', snippet: "padding = '${1:0}'", description: 'Shorthand padding' },
            { name: 'paddingTop', snippet: "paddingTop = '${1:0}'", description: 'Top padding' },
            { name: 'paddingRight', snippet: "paddingRight = '${1:0}'", description: 'Right padding' },
            { name: 'paddingBottom', snippet: "paddingBottom = '${1:0}'", description: 'Bottom padding' },
            { name: 'paddingLeft', snippet: "paddingLeft = '${1:0}'", description: 'Left padding' },
            { name: 'boxSizing', snippet: "boxSizing = '${1:border-box}'", description: 'Box sizing: content-box|border-box' },
            // Border
            { name: 'border', snippet: "border = '${1:1px solid #ccc}'", description: 'Shorthand border' },
            { name: 'borderTop', snippet: "borderTop = '${1:1px solid #ccc}'", description: 'Top border' },
            { name: 'borderRight', snippet: "borderRight = '${1:1px solid #ccc}'", description: 'Right border' },
            { name: 'borderBottom', snippet: "borderBottom = '${1:1px solid #ccc}'", description: 'Bottom border' },
            { name: 'borderLeft', snippet: "borderLeft = '${1:1px solid #ccc}'", description: 'Left border' },
            { name: 'borderWidth', snippet: "borderWidth = '${1:1px}'", description: 'Border width' },
            { name: 'borderStyle', snippet: "borderStyle = '${1:solid}'", description: 'Border style: solid|dashed|dotted...' },
            { name: 'borderColor', snippet: "borderColor = '${1:#ccc}'", description: 'Border color' },
            { name: 'borderRadius', snippet: "borderRadius = '${1:4px}'", description: 'Rounded corners' },
            { name: 'outline', snippet: "outline = '${1:none}'", description: 'Outline (does not affect layout)' },
            { name: 'outlineOffset', snippet: "outlineOffset = '${1:2px}'", description: 'Space between element and outline' },
            // Colors
            { name: 'color', snippet: "color = '${1:#000}'", description: 'Text color' },
            { name: 'backgroundColor', snippet: "backgroundColor = '${1:#fff}'", description: 'Background color' },
            { name: 'background', snippet: "background = '${1:none}'", description: 'Shorthand background' },
            { name: 'backgroundImage', snippet: "backgroundImage = '${1:url(\\'image.png\\')}'", description: 'Background image' },
            { name: 'backgroundSize', snippet: "backgroundSize = '${1:cover}'", description: 'Background size: cover|contain|auto' },
            { name: 'backgroundPosition', snippet: "backgroundPosition = '${1:center}'", description: 'Background position' },
            { name: 'backgroundRepeat', snippet: "backgroundRepeat = '${1:no-repeat}'", description: 'Background repeat' },
            // Typography
            { name: 'fontSize', snippet: "fontSize = '${1:16px}'", description: 'Font size' },
            { name: 'fontWeight', snippet: "fontWeight = '${1:bold}'", description: 'Font weight: normal|bold|100–900' },
            { name: 'fontStyle', snippet: "fontStyle = '${1:italic}'", description: 'Font style: normal|italic|oblique' },
            { name: 'fontFamily', snippet: "fontFamily = '${1:Arial, sans-serif}'", description: 'Font family' },
            { name: 'lineHeight', snippet: "lineHeight = '${1:1.5}'", description: 'Line height' },
            { name: 'letterSpacing', snippet: "letterSpacing = '${1:0.05em}'", description: 'Letter spacing' },
            { name: 'wordSpacing', snippet: "wordSpacing = '${1:normal}'", description: 'Word spacing' },
            { name: 'textAlign', snippet: "textAlign = '${1:center}'", description: 'Text alignment: left|center|right|justify' },
            { name: 'textDecoration', snippet: "textDecoration = '${1:none}'", description: 'Text decoration: none|underline|line-through...' },
            { name: 'textTransform', snippet: "textTransform = '${1:uppercase}'", description: 'Text transform: none|uppercase|lowercase|capitalize' },
            { name: 'textOverflow', snippet: "textOverflow = '${1:ellipsis}'", description: 'Text overflow: clip|ellipsis' },
            { name: 'whiteSpace', snippet: "whiteSpace = '${1:nowrap}'", description: 'White space handling: normal|nowrap|pre...' },
            { name: 'wordBreak', snippet: "wordBreak = '${1:break-word}'", description: 'Word break: normal|break-all|break-word' },
            { name: 'verticalAlign', snippet: "verticalAlign = '${1:middle}'", description: 'Vertical alignment' },
            // Position
            { name: 'position', snippet: "position = '${1:absolute}'", description: 'Position: static|relative|absolute|fixed|sticky' },
            { name: 'top', snippet: "top = '${1:0}'", description: 'Top position offset' },
            { name: 'right', snippet: "right = '${1:0}'", description: 'Right position offset' },
            { name: 'bottom', snippet: "bottom = '${1:0}'", description: 'Bottom position offset' },
            { name: 'left', snippet: "left = '${1:0}'", description: 'Left position offset' },
            { name: 'zIndex', snippet: "zIndex = '${1:10}'", description: 'Stacking order' },
            { name: 'float', snippet: "float = '${1:left}'", description: 'Float: none|left|right' },
            { name: 'clear', snippet: "clear = '${1:both}'", description: 'Clear floats: none|left|right|both' },
            // Flexbox
            { name: 'flexDirection', snippet: "flexDirection = '${1:row}'", description: 'Flex direction: row|column|row-reverse|column-reverse' },
            { name: 'flexWrap', snippet: "flexWrap = '${1:wrap}'", description: 'Flex wrap: nowrap|wrap|wrap-reverse' },
            { name: 'justifyContent', snippet: "justifyContent = '${1:center}'", description: 'Flex justify: flex-start|center|flex-end|space-between...' },
            { name: 'alignItems', snippet: "alignItems = '${1:center}'", description: 'Flex align cross-axis: stretch|center|flex-start|flex-end' },
            { name: 'alignSelf', snippet: "alignSelf = '${1:auto}'", description: 'Flex self-alignment override' },
            { name: 'alignContent', snippet: "alignContent = '${1:center}'", description: 'Flex multi-line cross-axis alignment' },
            { name: 'flex', snippet: "flex = '${1:1}'", description: 'Shorthand flex grow/shrink/basis' },
            { name: 'flexGrow', snippet: "flexGrow = '${1:1}'", description: 'Flex grow factor' },
            { name: 'flexShrink', snippet: "flexShrink = '${1:0}'", description: 'Flex shrink factor' },
            { name: 'flexBasis', snippet: "flexBasis = '${1:auto}'", description: 'Initial flex item size' },
            { name: 'gap', snippet: "gap = '${1:8px}'", description: 'Gap between flex/grid items' },
            { name: 'rowGap', snippet: "rowGap = '${1:8px}'", description: 'Row gap' },
            { name: 'columnGap', snippet: "columnGap = '${1:8px}'", description: 'Column gap' },
            // Grid
            { name: 'gridTemplateColumns', snippet: "gridTemplateColumns = '${1:repeat(3, 1fr)}'", description: 'Grid column template' },
            { name: 'gridTemplateRows', snippet: "gridTemplateRows = '${1:auto}'", description: 'Grid row template' },
            { name: 'gridColumn', snippet: "gridColumn = '${1:span 2}'", description: 'Grid column placement' },
            { name: 'gridRow', snippet: "gridRow = '${1:span 2}'", description: 'Grid row placement' },
            { name: 'gridArea', snippet: "gridArea = '${1:header}'", description: 'Grid area name or placement' },
            // Transforms & Animations
            { name: 'transform', snippet: "transform = '${1:translateX(0)}'", description: 'CSS transform function(s)' },
            { name: 'transformOrigin', snippet: "transformOrigin = '${1:center}'", description: 'Transform origin point' },
            { name: 'transition', snippet: "transition = '${1:all 0.3s ease}'", description: 'CSS transition shorthand' },
            { name: 'transitionProperty', snippet: "transitionProperty = '${1:opacity}'", description: 'Property to transition' },
            { name: 'transitionDuration', snippet: "transitionDuration = '${1:0.3s}'", description: 'Transition duration' },
            { name: 'transitionTimingFunction', snippet: "transitionTimingFunction = '${1:ease}'", description: 'Transition easing function' },
            { name: 'transitionDelay', snippet: "transitionDelay = '${1:0s}'", description: 'Transition delay' },
            { name: 'animation', snippet: "animation = '${1:name 1s ease infinite}'", description: 'CSS animation shorthand' },
            { name: 'animationName', snippet: "animationName = '${1:keyframeName}'", description: 'Keyframe animation name' },
            { name: 'animationDuration', snippet: "animationDuration = '${1:1s}'", description: 'Animation duration' },
            { name: 'animationTimingFunction', snippet: "animationTimingFunction = '${1:ease}'", description: 'Animation easing function' },
            { name: 'animationDelay', snippet: "animationDelay = '${1:0s}'", description: 'Animation delay' },
            { name: 'animationIterationCount', snippet: "animationIterationCount = '${1:infinite}'", description: 'Animation repeat count' },
            { name: 'animationDirection', snippet: "animationDirection = '${1:normal}'", description: 'Animation direction: normal|reverse|alternate' },
            { name: 'animationFillMode', snippet: "animationFillMode = '${1:forwards}'", description: 'Animation fill mode: none|forwards|backwards|both' },
            { name: 'animationPlayState', snippet: "animationPlayState = '${1:paused}'", description: 'Animation play state: running|paused' },
            // Miscellaneous
            { name: 'cursor', snippet: "cursor = '${1:pointer}'", description: 'Cursor style: pointer|default|text|grab...' },
            { name: 'pointerEvents', snippet: "pointerEvents = '${1:none}'", description: 'Pointer events: auto|none' },
            { name: 'userSelect', snippet: "userSelect = '${1:none}'", description: 'Text selection: auto|none|all|text' },
            { name: 'boxShadow', snippet: "boxShadow = '${1:0 2px 4px rgba(0,0,0,0.2)}'", description: 'Box shadow' },
            { name: 'textShadow', snippet: "textShadow = '${1:1px 1px 2px rgba(0,0,0,0.5)}'", description: 'Text shadow' },
            { name: 'filter', snippet: "filter = '${1:blur(4px)}'", description: 'CSS filter functions' },
            { name: 'backdropFilter', snippet: "backdropFilter = '${1:blur(8px)}'", description: 'Backdrop filter (e.g. frosted glass)' },
            { name: 'clipPath', snippet: "clipPath = '${1:circle(50%)}'", description: 'Clip element to shape' },
            { name: 'objectFit', snippet: "objectFit = '${1:cover}'", description: 'Image/video fit: fill|contain|cover|none' },
            { name: 'objectPosition', snippet: "objectPosition = '${1:center}'", description: 'Image/video position within box' },
            { name: 'aspectRatio', snippet: "aspectRatio = '${1:16/9}'", description: 'Aspect ratio' },
            { name: 'resize', snippet: "resize = '${1:none}'", description: 'Resize handle: none|both|horizontal|vertical' },
            { name: 'listStyle', snippet: "listStyle = '${1:none}'", description: 'List style shorthand' },
            { name: 'tableLayout', snippet: "tableLayout = '${1:fixed}'", description: 'Table layout: auto|fixed' },
            { name: 'borderCollapse', snippet: "borderCollapse = '${1:collapse}'", description: 'Table border collapse: collapse|separate' },
            { name: 'content', snippet: "content = '${1:\"\"}'", description: 'Generated content (::before/::after)' },
            { name: 'cssText', snippet: "cssText = '${1:}'", description: 'Set all inline styles as a string' },
            { name: 'cssFloat', snippet: "cssFloat = '${1:left}'", description: 'Float (cssFloat for JS, float in CSS)' },
            { name: 'getPropertyValue', snippet: "getPropertyValue('${1:--my-var}')", description: 'Get CSS custom property value' },
            { name: 'setProperty', snippet: "setProperty('${1:--my-var}', '${2:value}')", description: 'Set CSS custom property' },
            { name: 'removeProperty', snippet: "removeProperty('${1:--my-var}')", description: 'Remove CSS custom property' },
        ], vscode.CompletionItemKind.Property, 'style');
    }

    private buildReflectItems(): vscode.CompletionItem[] {
        return this.buildItems([
            { name: 'apply', snippet: 'apply(${1:target}, ${2:thisArg}, ${3:args})', description: 'Call function with given this and args array' },
            { name: 'construct', snippet: 'construct(${1:Target}, ${2:args})', description: 'new Target(...args)' },
            { name: 'get', snippet: "get(${1:target}, '${2:prop}')", description: 'Get property value' },
            { name: 'set', snippet: "set(${1:target}, '${2:prop}', ${3:value})", description: 'Set property value, returns success boolean' },
            { name: 'has', snippet: "has(${1:target}, '${2:prop}')", description: 'in operator as function' },
            { name: 'deleteProperty', snippet: "deleteProperty(${1:target}, '${2:prop}')", description: 'delete operator as function' },
            { name: 'ownKeys', snippet: 'ownKeys(${1:target})', description: 'Get all own property keys (like Object.getOwnPropertyNames + Symbols)' },
            { name: 'defineProperty', snippet: "defineProperty(${1:target}, '${2:prop}', ${3:descriptor})", description: 'Define property descriptor' },
            { name: 'getOwnPropertyDescriptor', snippet: "getOwnPropertyDescriptor(${1:target}, '${2:prop}')", description: 'Get property descriptor' },
            { name: 'getPrototypeOf', snippet: 'getPrototypeOf(${1:target})', description: 'Get prototype' },
            { name: 'setPrototypeOf', snippet: 'setPrototypeOf(${1:target}, ${2:proto})', description: 'Set prototype' },
            { name: 'isExtensible', snippet: 'isExtensible(${1:target})', description: 'Check if object is extensible' },
            { name: 'preventExtensions', snippet: 'preventExtensions(${1:target})', description: 'Prevent new properties from being added' },
        ], vscode.CompletionItemKind.Function, 'Reflect');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// extractUserJsSymbols
// Lightweight scan of <script> block content in the current document for
// user-declared function names and var/let/const variable names.
// Returns lists of unique names so JsCompletionProvider can offer them.
// ─────────────────────────────────────────────────────────────────────────────

function extractUserJsSymbols(docText: string): { functions: string[]; variables: string[] } {
    const functions: string[] = [];
    const variables: string[] = [];
    const seenFn  = new Set<string>();
    const seenVar = new Set<string>();

    // Extract content of every <script> block (excluding language="vbscript")
    const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRe.exec(docText)) !== null) {
        const attrs   = match[1];
        const body    = match[2];
        if (/language\s*=\s*["']vbscript["']/i.test(attrs)) { continue; }

        // Named function declarations: function myFunc(
        const fnRe = /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g;
        let fm: RegExpExecArray | null;
        while ((fm = fnRe.exec(body)) !== null) {
            const name = fm[1];
            if (!seenFn.has(name)) { seenFn.add(name); functions.push(name); }
        }

        // Arrow / assigned functions: const myFunc = (  or  const myFunc = async (
        const arrowRe = /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g;
        while ((fm = arrowRe.exec(body)) !== null) {
            const name = fm[1];
            if (!seenFn.has(name)) { seenFn.add(name); functions.push(name); }
        }

        // Variable declarations: var/let/const x, y, z
        const varRe = /\b(?:var|let|const)\s+([a-zA-Z_$][\w$]*)/g;
        while ((fm = varRe.exec(body)) !== null) {
            const name = fm[1];
            // Skip if already captured as a function
            if (seenFn.has(name)) { continue; }
            if (!seenVar.has(name)) { seenVar.add(name); variables.push(name); }
        }
    }

    return { functions, variables };
}