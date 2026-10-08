/**
 * htmlLanguageFeatures.ts  (html/)
 *
 * What VS Code's own HTML support gives a .html file, for the markup of a page:
 * hovers on tags and attributes, the values an attribute takes (`type="`,
 * `target="`), and linked editing of a tag pair. It is the same library —
 * vscode-html-languageservice — run over the page with its ASP blanked out, so
 * a `<%= x %>` between two tags is space to it, not markup it cannot read.
 */

import * as vscode from 'vscode';
import { otherSetting } from '../platform/settings';
import type * as HtmlLs from 'vscode-html-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { getAspBlockRanges } from '../core/zoneUtils';
import { textOf, zonesFor } from '../platform/documentState';
import type { BlockEvent } from '../vbscript/pageAnalysis';
import { analysedPage } from '../asp/vbscriptWorkspace';
import { fromLspCompletion, fromLspMarkdown, fromLspRange } from '../platform/lspConvert';

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
        document.uri.toString(), 'html', document.version, maskAspBlocks(textOf(document)),
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

// ── Attribute values ──────────────────────────────────────────────────────────

/** The values the attribute at `position` takes — `text`, `checkbox`… after `type="`. */
export function htmlAttributeValueCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.CompletionItem[] {
    const page = parse(document);
    // The service read the page line for line, so its ranges are the page's.
    return htmlService().doComplete(page.document, position, page.html).items
        .map(value => fromLspCompletion(value, { kind: vscode.CompletionItemKind.Value, useRange: true }));
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
