/**
 * htmlLanguageFeatures.ts  (providers/)
 *
 * What VS Code's own HTML support gives a .html file, for the markup of a page:
 * hovers on tags and attributes, the values an attribute takes (`type="`,
 * `target="`), and linked editing of a tag pair. It is the same library —
 * vscode-html-languageservice — run over the page with its ASP blanked out, so
 * a `<%= x %>` between two tags is space to it, not markup it cannot read.
 */

import * as vscode from 'vscode';
import type * as HtmlLs from 'vscode-html-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { getAspBlockRanges, getZone } from '../utils/zoneUtils';
import { branchEvents, classifyLine } from './aspStructureDiagnosticsProvider';

let _htmlLs:  typeof HtmlLs | undefined;
let _service: HtmlLs.LanguageService | undefined;

/** The library, loaded on first use: a page nobody hovers never needs it. */
function htmlLanguageServiceModule(): typeof HtmlLs {
    return (_htmlLs ??= require('vscode-html-languageservice') as typeof HtmlLs);
}

function htmlService(): HtmlLs.LanguageService {
    return (_service ??= htmlLanguageServiceModule().getLanguageService());
}

/**
 * The page with every `<% … %>` block turned to spaces. Line breaks stay, so
 * every offset, line and column still points at the same place.
 */
export function maskAspBlocks(text: string): string {
    return text.replace(/<%[\s\S]*?(?:%>|$)/g, block => block.replace(/[^\r\n]/g, ' '));
}

interface ParsedPage {
    version:  number;
    document: LsTextDocument;
    html:     HtmlLs.HTMLDocument;
}

const _parsed = new WeakMap<vscode.TextDocument, ParsedPage>();

/** The masked page and its parse, kept until the page changes. */
function parse(document: vscode.TextDocument): ParsedPage {
    const cached = _parsed.get(document);
    if (cached && cached.version === document.version) { return cached; }

    const lsDocument = LsTextDocument.create(
        document.uri.toString(), 'html', document.version, maskAspBlocks(document.getText()),
    );
    const page = { version: document.version, document: lsDocument, html: htmlService().parseHTMLDocument(lsDocument) };
    _parsed.set(document, page);
    return page;
}

const toRange = (range: HtmlLs.Range) =>
    new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);

function toMarkdown(contents: HtmlLs.MarkupContent | HtmlLs.MarkedString | HtmlLs.MarkedString[]): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    const parts = Array.isArray(contents) ? contents : [contents];
    parts.forEach((part, index) => {
        if (index > 0) { markdown.appendMarkdown('\n\n'); }
        if (typeof part === 'string') { markdown.appendMarkdown(part); }
        else if ('kind' in part) { if (part.kind === 'markdown') { markdown.appendMarkdown(part.value); } else { markdown.appendText(part.value); } }
        else { markdown.appendCodeblock(part.value, part.language); }
    });
    return markdown;
}

/** True when `position` is in the page's markup, not its VBScript, JavaScript or CSS. */
function inMarkup(document: vscode.TextDocument, position: vscode.Position): boolean {
    return getZone(document.getText(), document.offsetAt(position)) === 'html';
}

// ── Hover ─────────────────────────────────────────────────────────────────────

export class HtmlHoverProvider implements vscode.HoverProvider {
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        if (!inMarkup(document, position)) { return undefined; }

        // The same switches a .html file answers to.
        const settings = vscode.workspace.getConfiguration('html', document);
        const page  = parse(document);
        const hover = htmlService().doHover(page.document, position, page.html, {
            documentation: settings.get<boolean>('hover.documentation', true),
            references:    settings.get<boolean>('hover.references', true),
        });
        if (!hover) { return undefined; }
        return new vscode.Hover(toMarkdown(hover.contents), hover.range ? toRange(hover.range) : undefined);
    }
}

// ── Attribute values ──────────────────────────────────────────────────────────

/** The values the attribute at `position` takes — `text`, `checkbox`… after `type="`. */
export function htmlAttributeValueCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.CompletionItem[] {
    const page = parse(document);
    return htmlService().doComplete(page.document, position, page.html).items.map(value => {
        // LSP numbers its kinds from 1, VS Code from 0.
        const item = new vscode.CompletionItem(value.label, value.kind ? value.kind - 1 : vscode.CompletionItemKind.Value);
        const edit = value.textEdit;
        if (edit && 'range' in edit) {
            item.range      = toRange(edit.range);
            item.insertText = edit.newText;
        }
        if (value.documentation) {
            item.documentation = typeof value.documentation === 'string'
                ? value.documentation
                : toMarkdown(value.documentation);
        }
        item.sortText = value.sortText;
        return item;
    });
}

/** True when the HTML data lists values for this attribute, so picking it should show them. */
export function attributeHasValues(tagName: string, attribute: string): boolean {
    return htmlLanguageServiceModule().getDefaultHTMLDataProvider()
        .provideValues(tagName.toLowerCase(), attribute.toLowerCase()).length > 0;
}

// ── Linked editing ────────────────────────────────────────────────────────────

/**
 * True when the VBScript between two offsets opens nothing it does not close,
 * and has no ElseIf / Else / Case of a block that started outside.
 *
 * A tag pair that has code like that between it is not one pair at all:
 * `<% If a Then %><div class="x"><% Else %><div class="y"><% End If %>…</div>`
 * has two start tags for the one end tag, and renaming either one with the end
 * tag would leave the other branch unmatched.
 */
export function vbScriptBalancedBetween(text: string, from: number, to: number): boolean {
    let depth = 0;
    for (const block of getAspBlockRanges(text)) {
        if (block.start < from || block.end > to) { continue; }
        const code = text.slice(block.start + 2, block.end - 2);
        if (/^\s*[=@]/.test(code)) { continue; } // an output expression or a directive

        for (const line of code.split(/\r?\n/)) {
            if (depth === 0 && branchEvents(line).some(event => event.type === 'branch')) { return false; }
            for (const action of classifyLine(line)) {
                depth += action.type === 'open' ? 1 : -1;
                if (depth < 0) { return false; }
            }
        }
    }
    return depth === 0;
}

/**
 * Editing a tag name edits its partner too, when `editor.linkedEditing` is on
 * or after Start Linked Editing (Ctrl+Shift+F2) — the same VS Code feature a
 * .html file has, off unless the user turns it on.
 */
export class HtmlLinkedEditingProvider implements vscode.LinkedEditingRangeProvider {
    provideLinkedEditingRanges(document: vscode.TextDocument, position: vscode.Position): vscode.LinkedEditingRanges | undefined {
        if (!inMarkup(document, position)) { return undefined; }

        const page   = parse(document);
        const ranges = htmlService().findLinkedEditingRanges(page.document, position, page.html);
        if (!ranges || ranges.length !== 2) { return undefined; }

        const [first, second] = ranges.map(toRange).sort((a, b) => document.offsetAt(a.start) - document.offsetAt(b.start));
        if (!vbScriptBalancedBetween(document.getText(), document.offsetAt(first.end), document.offsetAt(second.start))) {
            return undefined;
        }
        return new vscode.LinkedEditingRanges([first, second]);
    }
}
