/**
 * htmlLanguageFeatures.ts  (providers/)
 *
 * What VS Code's own HTML support gives a .html file, for the markup of a page:
 * hovers on tags and attributes. It is the same library —
 * vscode-html-languageservice — run over the page with its ASP blanked out, so
 * a `<%= x %>` between two tags is space to it, not markup it cannot read.
 */

import * as vscode from 'vscode';
import type * as HtmlLs from 'vscode-html-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { getZone } from '../utils/zoneUtils';

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
