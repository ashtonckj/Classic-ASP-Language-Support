import * as vscode from 'vscode';
import { HTML_TAGS, isSelfClosingTag } from '../constants/htmlTags';
import { getAttributesForTag } from '../constants/htmlGlobals';
import {
    getContext,
    ContextType,
    getCurrentTagName,
    isInsideTagForAttributes
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

// ── Closing tag scanner ────────────────────────────────────────────────────

/**
 * Walks backward from `position` through the document to find the nearest
 * unclosed HTML block-level (and inline) tag.
 *
 * Rules:
 *  - Self-closing / void tags are skipped entirely.
 *  - ASP blocks (<% ... %>) are skipped so VBScript doesn't confuse the scan.
 *  - Matched open/close pairs cancel each other out (stack-based).
 *
 * Returns the unclosed tag name and the leading whitespace of the line it
 * opened on (used to snap the closing tag to the correct indent level).
 * Returns null when no unclosed tag is found.
 */
function findUnclosedTag(
    document: vscode.TextDocument,
    position: vscode.Position
): { tag: string; openerIndent: string } | null {
    const text        = document.getText();
    const cursorOffset = document.offsetAt(position);

    // We only scan up to the cursor position
    const before = text.slice(0, cursorOffset);

    const stack: string[] = [];

    // Regex matches either:
    //   opening tag  <tagname ...>   (group 1 = tag name)
    //   closing tag  </tagname>      (group 2 = tag name)
    //   ASP block    <% ... %>       (group 3 = whole block, to skip)
    const tagPattern = /(<\s*\/\s*([a-zA-Z][a-zA-Z0-9]*)\s*>)|(<\s*([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?>)|(<%-?[\s\S]*?%>)/g;

    let m: RegExpExecArray | null;
    const tokens: Array<{ open: boolean; tag: string; index: number }> = [];

    while ((m = tagPattern.exec(before)) !== null) {
        if (m[5]) { continue; }  // ASP block — skip

        if (m[2]) {
            // Closing tag </tag>
            tokens.push({ open: false, tag: m[2].toLowerCase(), index: m.index });
        } else if (m[4]) {
            // Opening tag <tag ...>
            const tag = m[4].toLowerCase();
            if (!isSelfClosingTag(tag)) {
                // Also skip tags that are self-closed inline: <br />, <input ... />
                const full = m[0];
                if (!full.trimEnd().endsWith('/>')) {
                    tokens.push({ open: true, tag, index: m.index });
                }
            }
        }
    }

    // Walk tokens in reverse, balancing close tags against opens
    for (let i = tokens.length - 1; i >= 0; i--) {
        const tok = tokens[i];
        if (!tok.open) {
            // Closing tag — push onto stack so the matching open is skipped
            stack.push(tok.tag);
        } else {
            // Opening tag — if it matches the top of the close stack, pop it
            if (stack.length > 0 && stack[stack.length - 1] === tok.tag) {
                stack.pop();
            } else {
                // Unmatched opener — this is what we want to close
                const pos         = document.positionAt(tok.index);
                const openerIndent = document.lineAt(pos.line).text.match(/^([ \t]*)/)?.[1] ?? '';
                return { tag: tok.tag, openerIndent };
            }
        }
    }

    return null;
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
        const currentIndent = textBefore.match(/^([ \t]*)/)?.[1] ?? '';

        // ── Closing tag suggestion: triggered by `<` or `</` ────────────────
        //
        // When the user types `<` we prepend a `</tag>` item at the very top.
        // When the user types `</` we show ONLY the closing tag suggestion so
        // it completes immediately without noise from the full tag list.
        const typingClosingTag = /^([ \t]*)<\/$/.test(textBefore);
        const typingOpenAngle  = context.triggerCharacter === '<' || /^([ \t]*)<$/.test(textBefore);

        if (typingClosingTag || typingOpenAngle) {
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

        // ── Attribute suggestions ─────────────────────────────────────────────
        // Guard: if the cursor is inside a quoted attribute VALUE (e.g. href="../")
        // don't suggest attribute names — that's handled by other providers.
        const insideAttrValue = (() => {
            const lastOpen = textBefore.lastIndexOf('<');
            if (lastOpen === -1) { return false; }
            let inQuote: string | null = null;
            for (const ch of textBefore.slice(lastOpen)) {
                if (!inQuote && (ch === '"' || ch === "'")) { inQuote = ch; }
                else if (inQuote && ch === inQuote) { inQuote = null; }
            }
            return inQuote !== null;
        })();

        if (!insideAttrValue && isInsideTagForAttributes(document, position)) {
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