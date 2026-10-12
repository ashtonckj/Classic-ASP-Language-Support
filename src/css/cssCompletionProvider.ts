import * as vscode from 'vscode';
import type { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { buildInlineCssDoc, cssLanguageService, inlineDocOffset, inlinePageOffset, styleAttributeAt } from './cssUtils';
import { getParsedCssBlockAt } from './cssPageStylesheet';
import { textOf, zonesFor } from '../platform/documentState';
import { fromLspCompletion, type LspCompletionItem } from '../platform/lspConvert';

/**
 * The CSS service's items as VS Code's, each replacing the range the service
 * gave it — `background-co` whole, though the editor's word stops at the `-` —
 * moved from the document built around the CSS onto the page.
 */
function convertItems(
    document: vscode.TextDocument, cssDoc: LsTextDocument, lsItems: LspCompletionItem[], toPage: (cssOffset: number) => number,
): vscode.CompletionItem[] {
    return lsItems.map(item => {
        const converted = fromLspCompletion(item, { kind: vscode.CompletionItemKind.Property });
        const edit = item.textEdit;
        if (edit) {
            const range = 'range' in edit ? edit.range : edit.replace;
            converted.range = new vscode.Range(
                document.positionAt(toPage(cssDoc.offsetAt(range.start))),
                document.positionAt(toPage(cssDoc.offsetAt(range.end))),
            );
        }
        return converted;
    });
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
            const lsPosition = lsDoc.positionAt(inlineDocOffset(value.start, offset));
            const lsItems = cssLanguageService().doComplete(lsDoc, lsPosition, stylesheet).items;
            return convertItems(document, lsDoc, lsItems, o => inlinePageOffset(value.start, o));
        }

        // ── <style> block ──────────────────────────────────────────────────────
        if (zones.zoneAt(offset) !== 'css') return [];

        const block = getParsedCssBlockAt(document.uri.toString(), fullText, document.version, zones.cssBlocks, offset);
        if (!block) return [];

        const lsPosition = block.cssDoc.positionAt(offset - block.range.start);
        const lsItems = cssLanguageService().doComplete(block.cssDoc, lsPosition, block.stylesheet).items;
        return convertItems(document, block.cssDoc, lsItems, o => o + block.range.start);
    }
}
