import * as vscode from 'vscode';
import { HTML_TAGS, isInlineTag, isSelfClosingTag } from '../constants/htmlTags';
import { getAttributesForTag } from '../constants/htmlGlobals';
import {
    getCurrentTagName,
    isInsideAttrValue,
    isInsideTagForAttributes
} from '../platform/documentHelper';
import { zonesFor } from '../platform/documentState';
import { attributeHasValues, attributesOnTag, htmlAttributeValueCompletions, inHtmlComment, unclosedElementBefore } from './htmlLanguageFeatures';


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
            : isInlineTag(tag.tag)
                ? new vscode.SnippetString(`${tag.tag}>$0</${tag.tag}>`)
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
        // An attribute with a known set of values goes straight on to offer
        // them, as it does in a .html file.
        if (attributeHasValues(tagName, attr.name)) {
            item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest values' };
        }
        return item;
    });

    _cachedAttrCompletions.set(key, items);
    return items;
}

// ── Closing tag ────────────────────────────────────────────────────────────

/**
 * The nearest unclosed element before `position`, and the leading whitespace
 * of the line it opened on (used to snap the closing tag to its indent).
 */
function findUnclosedTag(
    document: vscode.TextDocument,
    position: vscode.Position
): { tag: string; openerIndent: string } | null {
    const element = unclosedElementBefore(document, position);
    if (!element) { return null; }
    const line = document.positionAt(element.start).line;
    return { tag: element.tag, openerIndent: document.lineAt(line).text.match(/^([ \t]*)/)?.[1] ?? '' };
}

// ── Completion provider ────────────────────────────────────────────────────

export class HtmlCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const offset = document.offsetAt(position);
        if (zonesFor(document).zoneAt(offset) !== 'html') { return []; }
        // A .html file offers no markup inside a comment either.
        if (inHtmlComment(document, offset)) { return []; }

        const textBefore = document.lineAt(position.line).text.substring(0, position.character);
        const currentIndent = textBefore.match(/^([ \t]*)/)?.[1] ?? '';

        // ── Closing tag suggestion: triggered by `<` or `</` ────────────────
        //
        // When the user types `<` we prepend a `</tag>` item at the very top.
        // When the user types `</` we show ONLY the closing tag suggestion so
        // it completes immediately without noise from the full tag list.
        const typingClosingTag = /^([ \t]*)<\/$/.test(textBefore);
        const typingOpenAngle  = context.triggerCharacter === '<' || /^([ \t]*)<$/.test(textBefore);

        const insideAttrValue = isInsideAttrValue(textBefore);

        // Never suggest closing tags when the cursor is inside a quoted attribute
        // value — typing `<` in href="<" should not inject `</a>` into the value.
        if (!insideAttrValue && (typingClosingTag || typingOpenAngle)) {
            const unclosed = findUnclosedTag(document, position);

            if (unclosed) {
                const { tag, openerIndent } = unclosed;

                // Build the closing tag completion item.
                // insertText: just the tag name + > (the </ is already typed for
                // the </  case; for the < case we include the full </tag>).
                const insertText = typingClosingTag
                    ? new vscode.SnippetString(`${tag}>`)
                    : new vscode.SnippetString(`/${tag}>`);

                const item = new vscode.CompletionItem(`/${tag}`, vscode.CompletionItemKind.Property);
                item.detail        = `Close <${tag}>`;
                item.documentation = new vscode.MarkdownString(`Closes the nearest unclosed \`<${tag}>\` tag.`);
                item.insertText    = insertText;
                item.filterText    = `/${tag}`;
                // Sort to absolute top — '0_' beats '2_' used by regular tags
                item.sortText      = '0_' + tag;

                // additionalTextEdits: snap the current line's indent to the
                // opener's indent level so `</div>` aligns with its `<div>`.
                if (openerIndent !== currentIndent) {
                    const lineStart = new vscode.Position(position.line, 0);
                    const indentEnd = new vscode.Position(position.line, currentIndent.length);
                    item.additionalTextEdits = [
                        vscode.TextEdit.replace(
                            new vscode.Range(lineStart, indentEnd),
                            openerIndent
                        ),
                    ];
                }

                if (typingClosingTag) {
                    // User typed `</` — show ONLY the closing tag, nothing else
                    return [item];
                }

                // User typed `<` — prepend the closing tag at top, then all
                // normal tags below it
                return [item, ...getTagCompletions()];
            }
        }

        // ── Normal tag suggestions ────────────────────────────────────────────
        if (context.triggerCharacter === '<') { return getTagCompletions(); }
        if (textBefore.match(/<(\w+)$/))      { return getTagCompletions(); }

        // ── Attribute values  e.g. type="|" → text, checkbox, … ───────────────
        if (insideAttrValue && isInsideTagForAttributes(document, position)) {
            return htmlAttributeValueCompletions(document, position);
        }

        // ── Attribute suggestions ─────────────────────────────────────────────
        // Guard: insideAttrValue is computed above, before the closing-tag block.
        if (!insideAttrValue && isInsideTagForAttributes(document, position)) {
            const tagName = getCurrentTagName(document, position);
            if (tagName) {
                // Anywhere in the tag, on any of its lines, as in a .html file;
                // an attribute the tag already has is not offered again.
                const written = attributesOnTag(document, position);
                const typing  = textBefore.match(/[\w-]*$/)?.[0].toLowerCase() ?? '';
                return getAttributeCompletions(tagName)
                    .filter(item => item.label === typing || !written.has(String(item.label).toLowerCase()));
            }
        }

        return [];
    }
}