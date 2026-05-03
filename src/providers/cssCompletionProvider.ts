import * as vscode from 'vscode';
import { getCSSLanguageService, CompletionItemKind as LsKind, InsertTextFormat } from 'vscode-css-languageservice';
import { getZone, buildCssDoc, getInlineStyleContext, buildInlineCssDoc } from '../utils/cssUtils';

const cssService = getCSSLanguageService();

function mapKind(lsKind: LsKind | undefined): vscode.CompletionItemKind {
    switch (lsKind) {
        case LsKind.Text:          return vscode.CompletionItemKind.Text;
        case LsKind.Method:        return vscode.CompletionItemKind.Method;
        case LsKind.Function:      return vscode.CompletionItemKind.Function;
        case LsKind.Constructor:   return vscode.CompletionItemKind.Constructor;
        case LsKind.Field:         return vscode.CompletionItemKind.Field;
        case LsKind.Variable:      return vscode.CompletionItemKind.Variable;
        case LsKind.Class:         return vscode.CompletionItemKind.Class;
        case LsKind.Interface:     return vscode.CompletionItemKind.Interface;
        case LsKind.Module:        return vscode.CompletionItemKind.Module;
        case LsKind.Property:      return vscode.CompletionItemKind.Property;
        case LsKind.Unit:          return vscode.CompletionItemKind.Unit;
        case LsKind.Value:         return vscode.CompletionItemKind.Value;
        case LsKind.Enum:          return vscode.CompletionItemKind.Enum;
        case LsKind.Keyword:       return vscode.CompletionItemKind.Keyword;
        case LsKind.Snippet:       return vscode.CompletionItemKind.Snippet;
        case LsKind.Color:         return vscode.CompletionItemKind.Color;
        case LsKind.File:          return vscode.CompletionItemKind.File;
        case LsKind.Reference:     return vscode.CompletionItemKind.Reference;
        default:                   return vscode.CompletionItemKind.Property;
    }
}

/**
 * Extracts the insert text from a CSS completion item.
 * The CSS language service puts the actual text in textEdit.newText, not in insertText, so we need to check both places.
 */
function getInsertText(item: any): string | undefined {
    if (item.textEdit) {
        const newText = item.textEdit.newText ?? item.textEdit.insert?.newText;
        if (newText) return newText;
    }
    if (typeof item.insertText === 'string') return item.insertText;
    return typeof item.label === 'string' ? item.label : undefined;
}

/**
 * Converts a list of CSS language service completion items to VS Code completion items.
 * Shared between <style> block and inline style="" completions.
 */
function convertItems(lsItems: any[]): vscode.CompletionItem[] {
    return lsItems.map(item => {
        const vsItem = new vscode.CompletionItem(
            typeof item.label === 'string' ? item.label : (item.label as any).label,
            mapKind(item.kind)
        );

        if (item.detail) vsItem.detail = item.detail;

        if (item.documentation) {
            vsItem.documentation = typeof item.documentation === 'string'
                ? item.documentation
                : new vscode.MarkdownString(item.documentation.value);
        }

        const insertText = getInsertText(item);
        if (insertText) {
            vsItem.insertText = item.insertTextFormat === InsertTextFormat.Snippet
                ? new vscode.SnippetString(insertText)
                : insertText;
        }

        if (item.filterText) vsItem.filterText = item.filterText;
        if (item.sortText) vsItem.sortText = item.sortText;

        return vsItem;
    });
}

export class CssCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] {
        const content = document.getText();
        const offset = document.offsetAt(position);
        const zone = getZone(content, offset);

        // ── Inline style="" attribute ──────────────────────────────────────────
        // Run inline detection for html, asp, and js zones — style="" can appear anywhere in the HTML markup regardless of what other zones are nearby.
        // Crucially we do NOT run this for the css zone (inside <style> blocks) because style="" never appears inside a <style> block.
        if (zone !== 'css') {
            const inlineCtx = getInlineStyleContext(content, offset);
            if (inlineCtx) {
                const lsDoc = buildInlineCssDoc(
                    document.uri.toString(),
                    content,
                    document.version,
                    inlineCtx.valueStart,
                    inlineCtx.valueEnd
                );

                const stylesheet = cssService.parseStylesheet(lsDoc);
                // Use the wrapped offset so the CSS service knows where we are inside the fake "* { ... }" ruleset
                const lsPosition = lsDoc.positionAt(inlineCtx.wrappedOffset);
                const lsItems = cssService.doComplete(lsDoc, lsPosition, stylesheet).items;

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

        const lsDoc = buildCssDoc(document.uri.toString(), content, document.version, offset);
        if (!lsDoc) return [];

        const stylesheet = cssService.parseStylesheet(lsDoc);
        const lsPosition = lsDoc.positionAt(offset);
        const lsItems = cssService.doComplete(lsDoc, lsPosition, stylesheet).items;

        return convertItems(lsItems);
    }
}