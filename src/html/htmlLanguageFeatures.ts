/**
 * htmlLanguageFeatures.ts  (html/)
 *
 * What VS Code's own HTML support gives a .html file, for the markup of a page:
 * tag, attribute and value suggestions, hovers on tags and attributes, and
 * linked editing of a tag pair. It is the same library —
 * vscode-html-languageservice — run over the page with its ASP blanked out, so
 * a `<%= x %>` between two tags is space to it, not markup it cannot read.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { otherSetting } from '../platform/settings';
import type * as HtmlLs from 'vscode-html-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { getAspBlockRanges, inRanges } from '../core/zoneUtils';
import { loadHtmlService } from '../core/lazyModule';
import { textOf, zonesFor } from '../platform/documentState';
import type { BlockEvent } from '../vbscript/pageAnalysis';
import { analysedPage } from '../asp/vbscriptWorkspace';
import { fromLspCompletion, fromLspMarkdown, fromLspRange } from '../platform/lspConvert';

let _service: HtmlLs.LanguageService | undefined;

/**
 * The library, loaded on first use: a page nobody hovers never needs it. It
 * reads folders for path suggestions as VS Code's HTML support does, by
 * `file:` URL; the folder is read without blocking the extension host.
 */
function htmlService(): HtmlLs.LanguageService {
    const { FileType, getLanguageService } = loadHtmlService();
    return (_service ??= getLanguageService({
        fileSystemProvider: {
            stat: async () => { throw new Error('not needed'); },
            readDirectory: async uri => (await fs.promises.readdir(fileURLToPath(uri), { withFileTypes: true }))
                .map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown]),
        },
    }));
}

interface ParsedPage {
    version:  number;
    document: LsTextDocument;
    html:     HtmlLs.HTMLDocument;
    /** Where the values of the page's link attributes (href, src, form action…) are, read when first asked. */
    links?:   Array<{ start: number; end: number }>;
}

const _parsed = new WeakMap<vscode.TextDocument, ParsedPage>();

/** The masked page and its parse, kept until the page changes. */
function parse(document: vscode.TextDocument): ParsedPage {
    const cached = _parsed.get(document);
    if (cached && cached.version === document.version) { return cached; }

    const lsDocument = LsTextDocument.create(
        document.uri.toString(), 'html', document.version, zonesFor(document).markup.masked,
    );
    const page = { version: document.version, document: lsDocument, html: htmlService().parseHTMLDocument(lsDocument) };
    _parsed.set(document, page);
    return page;
}

/** True when `position` is in the page's markup, not its VBScript, JavaScript or CSS. */
function inMarkup(document: vscode.TextDocument, position: vscode.Position): boolean {
    return zonesFor(document).zoneAt(document.offsetAt(position)) === 'html';
}

// ── Hover ─────────────────────────────────────────────────────────────────────

export class HtmlHoverProvider implements vscode.HoverProvider {
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        if (!inMarkup(document, position)) { return undefined; }

        // The same switches a .html file answers to.
        const page  = parse(document);
        const hover = htmlService().doHover(page.document, position, page.html, {
            documentation: otherSetting<boolean>('html', 'hover.documentation', document) ?? true,
            references:    otherSetting<boolean>('html', 'hover.references', document) ?? true,
        });
        if (!hover) { return undefined; }
        return new vscode.Hover(fromLspMarkdown(hover.contents), hover.range ? fromLspRange(hover.range) : undefined);
    }
}

// ── Completion ────────────────────────────────────────────────────────────────

/**
 * The tags, closing tags, attributes and attribute values a .html file offers
 * at `position`, with the same `html.completion.attributeDefaultValue` setting.
 * The service read the page line for line, so its ranges are the page's.
 */
export function htmlCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionList {
    const page = parse(document);
    const list = htmlService().doComplete(page.document, position, page.html, {
        attributeDefaultValue: otherSetting<'doublequotes' | 'singlequotes' | 'empty'>('html', 'completion.attributeDefaultValue', document),
    });
    return new vscode.CompletionList(
        list.items.map(item => fromLspCompletion(item, { kind: vscode.CompletionItemKind.Property, useRange: true })),
        list.isIncomplete,
    );
}

/**
 * The files and folders a .html file offers inside a link attribute's value at
 * `position` — none anywhere else — with each path resolved by
 * `resolveReference` to a `file:` URL, or to nothing when it cannot be.
 */
export async function htmlPathCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    resolveReference: (ref: string) => string | undefined,
): Promise<vscode.CompletionItem[]> {
    if (!inMarkup(document, position)) { return []; }
    const page = parse(document);
    const { CompletionItemKind } = loadHtmlService();
    const list = await htmlService().doComplete2(page.document, position, page.html, { resolveReference });
    return list.items
        .filter(item => item.kind === CompletionItemKind.File || item.kind === CompletionItemKind.Folder)
        .map(item => fromLspCompletion(item, { kind: vscode.CompletionItemKind.File, useRange: true }));
}

/**
 * Where the values of the page's link attributes are — the attributes a .html
 * file links (href, src, form action…), as the HTML service finds them — as
 * offsets, without quotes. Values are as written; the caller resolves them.
 */
export function linkValues(document: vscode.TextDocument): Array<{ start: number; end: number }> {
    const page = parse(document);
    return (page.links ??= htmlService().findDocumentLinks(page.document, { resolveReference: ref => ref })
        .map(link => ({ start: page.document.offsetAt(link.range.start), end: page.document.offsetAt(link.range.end) })));
}

/** True when `offset` is inside an HTML comment, where a .html file offers no markup. */
export function inHtmlComment(document: vscode.TextDocument, offset: number): boolean {
    return inRanges(zonesFor(document).markup.comments, offset, true);
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
export function vbScriptBalancedBetween(text: string, from: number, to: number, events: BlockEvent[]): boolean {
    const blocks = getAspBlockRanges(text).filter(block => block.start >= from && block.end <= to);
    let depth = 0;
    for (const event of events) {
        if (!blocks.some(block => block.start <= event.at && event.at < block.end)) { continue; }
        if (event.type === 'branch') {
            if (depth === 0) { return false; }
            continue;
        }
        depth += event.type === 'open' ? 1 : -1;
        if (depth < 0) { return false; }
    }
    return depth === 0;
}

/**
 * Editing a tag name edits its partner too, when `editor.linkedEditing` is on
 * — the same VS Code feature a .html file has, off unless the user turns it on.
 */
export class HtmlLinkedEditingProvider implements vscode.LinkedEditingRangeProvider {
    async provideLinkedEditingRanges(
        document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken,
    ): Promise<vscode.LinkedEditingRanges | undefined> {
        if (!inMarkup(document, position)) { return undefined; }

        const page   = parse(document);
        const ranges = htmlService().findLinkedEditingRanges(page.document, position, page.html);
        if (!ranges || ranges.length !== 2) { return undefined; }

        const [first, second] = ranges.map(fromLspRange).sort((a, b) => document.offsetAt(a.start) - document.offsetAt(b.start));
        // The VBScript blocks between the two tags come from the worker.
        const version = document.version;
        const vbscript = await analysedPage(document, token);
        if (!vbscript || vbscript.version !== version) { return undefined; }
        if (!vbScriptBalancedBetween(textOf(document), document.offsetAt(first.end), document.offsetAt(second.start), vbscript.blocks.events)) {
            return undefined;
        }
        return new vscode.LinkedEditingRanges([first, second]);
    }
}
