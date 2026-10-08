import * as vscode from 'vscode';
import { buildCssDoc, getInlineStyleContext, buildInlineCssDoc, cssLanguageService } from './cssUtils';
import { textOf, zonesFor } from '../platform/documentState';
import { fromLspMarkdown } from '../platform/lspConvert';

export class CssHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | null {
        const fullText = textOf(document);
        const offset  = document.offsetAt(position);
        const zone    = zonesFor(document).zoneAt(offset);

        // ── Inline style="" attribute hover ───────────────────────────────────
        // Run for all non-css zones — style="" can appear in HTML, ASP, or JS zones.
        if (zone !== 'css') {
            const inlineCtx = getInlineStyleContext(fullText, offset);
            if (inlineCtx) {
                const lsDoc = buildInlineCssDoc(
                    document.uri.toString(),
                    fullText,
                    document.version,
                    inlineCtx.valueStart,
                    inlineCtx.valueEnd
                );
                const stylesheet = cssLanguageService().parseStylesheet(lsDoc);
                const lsPosition = lsDoc.positionAt(inlineCtx.wrappedOffset);
                const hover      = cssLanguageService().doHover(lsDoc, lsPosition, stylesheet);
                if (!hover) return null;
                return new vscode.Hover(fromLspMarkdown(hover.contents));
            }
            return null;
        }

        // ── <style> block hover ───────────────────────────────────────────────
        const lsDoc = buildCssDoc(document.uri.toString(), fullText, document.version, offset);
        if (!lsDoc) return null;

        const stylesheet = cssLanguageService().parseStylesheet(lsDoc);
        const lsPosition = lsDoc.positionAt(offset);
        const hover      = cssLanguageService().doHover(lsDoc, lsPosition, stylesheet);
        if (!hover) return null;

        return new vscode.Hover(fromLspMarkdown(hover.contents));
    }
}
