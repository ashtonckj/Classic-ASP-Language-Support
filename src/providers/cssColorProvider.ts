/**
 * cssColorProvider.ts  (providers/)
 *
 * Colour swatches and the colour picker for CSS in an ASP page — both inside
 * `<style>` blocks and inside `style=""` attributes.
 *
 * VS Code shows a small square beside every colour in a .css or .html file, and
 * clicking it opens the picker. That comes from a DocumentColorProvider, and an
 * .asp file had none, so a page full of `#f9fbb7` showed nothing.
 *
 * The colours themselves come from vscode-css-languageservice — the same library
 * already used for CSS diagnostics — rather than from a hand-written regex, so
 * every notation it understands (hex, rgb/rgba, hsl/hsla, named colours) is
 * covered, and the picker offers exactly the presentations a .css file offers.
 *
 * Two coordinate systems have to be reconciled:
 *
 *   * a `<style>` block's virtual document is POSITION-ALIGNED — buildCssDoc
 *     replaces everything before the block with spaces and keeps the newlines —
 *     so an offset in it is already an offset in the page;
 *   * an inline `style=""` value is wrapped in a fake `* { … }` ruleset so the
 *     parser sees valid CSS, which shifts every offset by the wrapper's prefix.
 *
 * Both are handled by converting the service's line/character positions to
 * offsets with the virtual document's own offsetAt, then applying one shift.
 */

import * as vscode from 'vscode';
import { getCSSLanguageService, Stylesheet } from 'vscode-css-languageservice';
import type { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { buildCssDoc, buildInlineCssDoc, getInlineStyleContext } from '../utils/cssUtils';
import { getParsedCssBlocks, pageOffset } from '../utils/cssPageStylesheet';
import { getCssBlockRanges } from '../utils/zoneUtils';

const cssService = getCSSLanguageService();

/** The wrapper buildInlineCssDoc puts in front of an inline declaration list. */
const INLINE_PREFIX = '* {  ';

/** Every `style="…"` attribute value in the page, as offsets. */
function inlineStyleValues(content: string): Array<{ valueStart: number; valueEnd: number }> {
    const values: Array<{ valueStart: number; valueEnd: number }> = [];
    const attribute = /\bstyle\s*=\s*("|')/gi;

    let match: RegExpExecArray | null;
    while ((match = attribute.exec(content)) !== null) {
        const quote      = match[1];
        const valueStart = match.index + match[0].length;
        const valueEnd   = content.indexOf(quote, valueStart);
        if (valueEnd === -1) { break; }

        // getInlineStyleContext is the authority on whether an offset really is
        // inside a style attribute value — it rejects a `style=` that is itself
        // inside an ASP block or another attribute's text. Ask it about this one.
        if (getInlineStyleContext(content, valueStart)) {
            values.push({ valueStart, valueEnd });
        }
        attribute.lastIndex = valueEnd + 1;
    }

    return values;
}

/**
 * Colours in one virtual CSS document, with each position shifted back into the
 * page by `toPageOffset`.
 *
 * `pageLength` is passed in rather than read from the document: this runs once
 * per <style> block and once per style="" attribute, and each read made the
 * editor hand back the entire page, 2,000 times on a page with 2,000 of them.
 */
function colorsIn(
    document:     vscode.TextDocument,
    cssDoc:       LsTextDocument,
    pageLength:   number,
    toPageOffset: (virtualOffset: number) => number,
    stylesheet?:  Stylesheet,
): vscode.ColorInformation[] {
    const parsed = stylesheet ?? cssService.parseStylesheet(cssDoc);
    const found: vscode.ColorInformation[] = [];

    for (const info of cssService.findDocumentColors(cssDoc, parsed)) {
        const start = toPageOffset(cssDoc.offsetAt(info.range.start));
        const end   = toPageOffset(cssDoc.offsetAt(info.range.end));
        if (start < 0 || end > pageLength || end <= start) { continue; }

        found.push(new vscode.ColorInformation(
            new vscode.Range(document.positionAt(start), document.positionAt(end)),
            new vscode.Color(info.color.red, info.color.green, info.color.blue, info.color.alpha),
        ));
    }

    return found;
}

export class CssColorProvider implements vscode.DocumentColorProvider {

    provideDocumentColors(
        document: vscode.TextDocument,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.ColorInformation[]> {

        const content = document.getText();
        const version = document.version;
        const uri     = document.uri.toString();
        const colors: vscode.ColorInformation[] = [];

        // Parsed once per document version and shared with CSS validation, which
        // wants the same blocks on its own debounce a moment later.
        for (const block of getParsedCssBlocks(uri, content, version, getCssBlockRanges(content))) {
            if (token.isCancellationRequested) { return undefined; }
            colors.push(...colorsIn(
                document, block.cssDoc, content.length,
                offset => pageOffset(block, offset),
                block.stylesheet,
            ));
        }

        for (const value of inlineStyleValues(content)) {
            if (token.isCancellationRequested) { return undefined; }
            const cssDoc = buildInlineCssDoc(uri, content, version, value.valueStart, value.valueEnd);
            colors.push(...colorsIn(
                document, cssDoc, content.length,
                offset => value.valueStart + offset - INLINE_PREFIX.length,
            ));
        }

        return colors;
    }

    provideColorPresentations(
        color:   vscode.Color,
        context: { document: vscode.TextDocument; range: vscode.Range },
        token:   vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.ColorPresentation[]> {

        const document = context.document;
        const content  = document.getText();
        const version  = document.version;
        const uri      = document.uri.toString();
        const start    = document.offsetAt(context.range.start);
        const end      = document.offsetAt(context.range.end);

        // Rebuild whichever virtual document holds the colour being edited, so
        // the service writes its replacement in the notation that fits there.
        const inline = inlineStyleValues(content)
            .find(v => start >= v.valueStart && end <= v.valueEnd);

        let cssDoc: LsTextDocument | null;
        let toVirtual: (pageOffset: number) => number;

        if (inline) {
            cssDoc    = buildInlineCssDoc(uri, content, version, inline.valueStart, inline.valueEnd);
            toVirtual = pageOffset => pageOffset - inline.valueStart + INLINE_PREFIX.length;
        } else {
            cssDoc    = buildCssDoc(uri, content, version, start);
            toVirtual = pageOffset => pageOffset;
        }
        if (!cssDoc || token.isCancellationRequested) { return undefined; }

        const stylesheet = cssService.parseStylesheet(cssDoc);
        const presentations = cssService.getColorPresentations(
            cssDoc, stylesheet,
            { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha },
            {
                start: cssDoc.positionAt(toVirtual(start)),
                end:   cssDoc.positionAt(toVirtual(end)),
            },
        );

        return presentations.map(p => {
            const presentation = new vscode.ColorPresentation(p.label);
            // The service's edit covers the colour it was asked about, which is
            // the range VS Code already gave us — so reuse that rather than
            // mapping the edit's own range back.
            if (p.textEdit) {
                presentation.textEdit = new vscode.TextEdit(context.range, p.textEdit.newText);
            }
            return presentation;
        });
    }
}
