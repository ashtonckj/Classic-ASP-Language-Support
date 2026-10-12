/**
 * htmlCompletionProvider.ts  (html/)
 *
 * Tag, closing-tag, attribute and attribute-value suggestions in the page's
 * markup, as a .html file gets them: from the HTML language service, over the
 * page's parse (htmlLanguageFeatures). Nothing is offered in VBScript,
 * JavaScript, CSS or an HTML comment.
 */

import * as vscode from 'vscode';
import { isInlineTag, isSelfClosingTag } from '../constants/htmlTags';
import { zonesFor } from '../platform/documentState';
import { htmlCompletions, inHtmlComment } from './htmlLanguageFeatures';

/**
 * A tag name picked after `<`, with nothing after it on the line, is written
 * whole and laid out by kind — `<br />`, `<span>…</span>` on the line, a block
 * opening onto lines of its own — where the HTML service writes the name alone.
 */
function layOutTag(item: vscode.CompletionItem, document: vscode.TextDocument, masked: string): void {
    const name = String(item.label);
    if (!(item.range instanceof vscode.Range) || name.startsWith('/')) { return; }
    const start = document.offsetAt(item.range.start);
    const end   = document.offsetAt(item.range.end);
    if (masked[start - 1] !== '<' || !/^[ \t]*(?:\r?\n|<|$)/.test(masked.slice(end, end + 200))) { return; }

    item.insertText = new vscode.SnippetString(
        isSelfClosingTag(name) ? `${name} $0/>`
            : isInlineTag(name) ? `${name}>$0</${name}>`
                : `${name}>\n\t$0\n</${name}>`,
    );
}

export class HtmlCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionList | undefined {
        const offset = document.offsetAt(position);
        const zones  = zonesFor(document);
        if (zones.zoneAt(offset) !== 'html' || inHtmlComment(document, offset)) { return undefined; }

        const list = htmlCompletions(document, position);
        for (const item of list.items) { layOutTag(item, document, zones.markup.masked); }
        return list;
    }
}
