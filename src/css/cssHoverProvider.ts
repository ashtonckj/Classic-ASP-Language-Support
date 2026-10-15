import * as vscode from 'vscode';
import { buildInlineCssDoc, cssLanguageService, inlineDocOffset, styleAttributeAt } from './cssUtils';
import { getParsedCssBlockAt } from './cssPageStylesheet';
import { textOf, zonesFor } from '../platform/documentState';
import { fromLspMarkdown } from '../platform/lspConvert';

export class CssHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | null {
        const fullText = textOf(document);
        const offset  = document.offsetAt(position);
        const zones   = zonesFor(document);

        // ── Inline style="" attribute hover ───────────────────────────────────
        const value = styleAttributeAt(zones, offset);
        if (value) {
            const lsDoc = buildInlineCssDoc(document.uri.toString(), fullText, document.version, value.start, value.end);
            const stylesheet = cssLanguageService().parseStylesheet(lsDoc);
            const lsPosition = lsDoc.positionAt(inlineDocOffset(value.start, offset));
            const hover      = cssLanguageService().doHover(lsDoc, lsPosition, stylesheet);
            if (!hover) return null;
            return new vscode.Hover(fromLspMarkdown(hover.contents));
        }

        // ── <style> block hover ───────────────────────────────────────────────
        if (zones.zoneAt(offset) !== 'css') return null;

        const block = getParsedCssBlockAt(document, offset);
        if (!block) return null;

        const lsPosition = block.cssDoc.positionAt(offset - block.range.start);
        const hover      = cssLanguageService().doHover(block.cssDoc, lsPosition, block.stylesheet);
        if (!hover) return null;

        return new vscode.Hover(fromLspMarkdown(hover.contents));
    }
}
