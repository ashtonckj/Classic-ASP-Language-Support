/**
 * cssColorProvider.ts  (css/)
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
 *   * a `<style>` block's virtual document holds just its body
 *     (buildCssBodyDoc), so an offset in it is shifted by where the body starts;
 *   * an inline `style=""` value is wrapped in a fake `* { … }` ruleset so the
 *     parser sees valid CSS, which shifts every offset by the wrapper's prefix.
 *
 * Only the page's own markup has colours: a style attribute or a <style> in a
 * VBScript or JavaScript string, or in a comment, is text there.
 *
 * Both are handled by converting the service's line/character positions to
 * offsets with the virtual document's own offsetAt, then applying one shift.
 */

import * as vscode from 'vscode';
import type { Stylesheet } from 'vscode-css-languageservice';
import type { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { buildInlineCssDoc, cssLanguageService, inlineDocOffset, inlinePageOffset } from './cssUtils';
import { getParsedCssBlockAt, getParsedCssBlocks, pageOffset } from './cssPageStylesheet';
import { textOf, zonesFor } from '../platform/documentState';

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
    const parsed = stylesheet ?? cssLanguageService().parseStylesheet(cssDoc);
    const found: vscode.ColorInformation[] = [];

    for (const info of cssLanguageService().findDocumentColors(cssDoc, parsed)) {
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

        const content = textOf(document);
        const version = document.version;
        const uri     = document.uri.toString();
        const colors: vscode.ColorInformation[] = [];

        // Parsed once per document version and shared with CSS validation, which
        // wants the same blocks on its own debounce a moment later.
        for (const block of getParsedCssBlocks(document)) {
            if (token.isCancellationRequested) { return undefined; }
            colors.push(...colorsIn(
                document, block.cssDoc, content.length,
                offset => pageOffset(block, offset),
                block.stylesheet,
            ));
        }

        for (const value of zonesFor(document).markup.styleAttributes) {
            if (token.isCancellationRequested) { return undefined; }
            const cssDoc = buildInlineCssDoc(uri, content, version, value.start, value.end);
            colors.push(...colorsIn(
                document, cssDoc, content.length,
                offset => inlinePageOffset(value.start, offset),
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
        const content  = textOf(document);
        const version  = document.version;
        const uri      = document.uri.toString();
        const start    = document.offsetAt(context.range.start);
        const end      = document.offsetAt(context.range.end);

        // Whichever virtual document holds the colour being edited, so the
        // service writes its replacement in the notation that fits there.
        const zones  = zonesFor(document);
        const inline = zones.markup.styleAttributes.find(v => start >= v.start && end <= v.end);

        let cssDoc: LsTextDocument;
        let stylesheet: Stylesheet;
        let toVirtual: (pageOffset: number) => number;

        if (inline) {
            cssDoc     = buildInlineCssDoc(uri, content, version, inline.start, inline.end);
            stylesheet = cssLanguageService().parseStylesheet(cssDoc);
            toVirtual  = pageOffset => inlineDocOffset(inline.start, pageOffset);
        } else {
            const block = getParsedCssBlockAt(document, start);
            if (!block) { return undefined; }
            ({ cssDoc, stylesheet } = block);
            toVirtual = pageOffset => pageOffset - block.range.start;
        }
        if (token.isCancellationRequested) { return undefined; }

        const presentations = cssLanguageService().getColorPresentations(
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
