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


// ── Cached completion items — built once, reused on every keystroke ────────

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

// ── Completion provider ────────────────────────────────────────────────────

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