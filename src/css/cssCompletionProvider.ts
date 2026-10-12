import * as vscode from 'vscode';
import { buildInlineCssDoc, cssLanguageService, INLINE_PREFIX, styleAttributeAt } from './cssUtils';
import { getParsedCssBlockAt } from './cssPageStylesheet';
import { textOf, zonesFor } from '../platform/documentState';
import { fromLspCompletion, type LspCompletionItem } from '../platform/lspConvert';

/**
 * The CSS service's items as VS Code's, for a <style> block and an inline
 * style alike. Their ranges are left out: each is read from a document built
 * around the CSS, whose positions are not the page's.
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
        const zones = zonesFor(document);

        // ── Inline style="" attribute ──────────────────────────────────────────
        const value = styleAttributeAt(zones, offset);
        if (value) {
            const lsDoc = buildInlineCssDoc(document.uri.toString(), fullText, document.version, value.start, value.end);
            const stylesheet = cssLanguageService().parseStylesheet(lsDoc);
            // Padded by 2 so the CSS service always lands inside the "* { … }" declaration list.
            const lsPosition = lsDoc.positionAt(INLINE_PREFIX.length + offset - value.start + 2);
            const lsItems = cssLanguageService().doComplete(lsDoc, lsPosition, stylesheet).items;

            // For inline styles, filter out suggestions that only make sense inside a full stylesheet (e.g. @media, selectors)
            const filtered = lsItems.filter(item => {
                const label = typeof item.label === 'string' ? item.label : (item.label as any).label;
                return !label.startsWith('@') && !label.startsWith('.');
            });

            return convertItems(filtered);
        }

        // ── <style> block ──────────────────────────────────────────────────────
        if (zones.zoneAt(offset) !== 'css') return [];

        const block = getParsedCssBlockAt(document.uri.toString(), fullText, document.version, zones.cssBlocks, offset);
        if (!block) return [];

        const lsPosition = block.cssDoc.positionAt(offset - block.range.start);
        return convertItems(cssLanguageService().doComplete(block.cssDoc, lsPosition, block.stylesheet).items);
    }
}
