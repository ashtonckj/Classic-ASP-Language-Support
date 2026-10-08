import * as vscode from 'vscode';
import { buildCssDoc, getInlineStyleContext, buildInlineCssDoc, cssLanguageService } from './cssUtils';
import { textOf, zonesFor } from '../platform/documentState';
import { fromLspCompletion, type LspCompletionItem } from '../platform/lspConvert';

/**
 * The CSS service's items as VS Code's, for a <style> block and an inline
 * style alike. Their ranges are left out: an inline style is read from a
 * document built around it, whose positions are not the page's.
 */
function convertItems(lsItems: LspCompletionItem[]): vscode.CompletionItem[] {
    return lsItems.map(item => fromLspCompletion(item, { kind: vscode.CompletionItemKind.Property }));
}

export class CssCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] {
        const fullText = textOf(document);
        const offset = document.offsetAt(position);
        const zone = zonesFor(document).zoneAt(offset);

        // ── Inline style="" attribute ──────────────────────────────────────────
        // Run inline detection for html, asp, and js zones — style="" can appear anywhere in the HTML markup regardless of what other zones are nearby.
        // Crucially we do NOT run this for the css zone (inside <style> blocks) because style="" never appears inside a <style> block.
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
                // Use the wrapped offset so the CSS service knows where we are inside the fake "* { ... }" ruleset
                const lsPosition = lsDoc.positionAt(inlineCtx.wrappedOffset);
                const lsItems = cssLanguageService().doComplete(lsDoc, lsPosition, stylesheet).items;

                // For inline styles, filter out suggestions that only make sense inside a full stylesheet (e.g. @media, selectors)
                const filtered = lsItems.filter(item => {
                    const label = typeof item.label === 'string' ? item.label : (item.label as any).label;
                    return !label.startsWith('@') && !label.startsWith('.');
                });

                return convertItems(filtered);
            }
        }

        // ── <style> block ──────────────────────────────────────────────────────
        if (zone !== 'css') return [];

        const lsDoc = buildCssDoc(document.uri.toString(), fullText, document.version, offset);
        if (!lsDoc) return [];

        const stylesheet = cssLanguageService().parseStylesheet(lsDoc);
        const lsPosition = lsDoc.positionAt(offset);
        const lsItems = cssLanguageService().doComplete(lsDoc, lsPosition, stylesheet).items;

        return convertItems(lsItems);
    }
}