import * as vscode from 'vscode';
import { getCSSLanguageService, CompletionItemKind as LsKind, InsertTextFormat, TextEdit } from 'vscode-css-languageservice';
import { getZone, buildCssDoc } from './cssUtils';

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
 * The CSS language service puts the actual text in textEdit.newText,
 * not in insertText, so we need to check both places.
 */
function getInsertText(item: any): string | undefined {
    // First preference: textEdit.newText (where CSS service actually puts it)
    if (item.textEdit) {
        const newText = item.textEdit.newText ?? item.textEdit.insert?.newText;
        if (newText) return newText;
    }
    // Fallback: insertText
    if (typeof item.insertText === 'string') return item.insertText;
    // Last resort: use the label
    return typeof item.label === 'string' ? item.label : undefined;
}

export class CssCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const content = document.getText();
        const offset = document.offsetAt(position);

        if (getZone(content, offset) !== 'css') return [];

        const lsDoc = buildCssDoc(document.uri.toString(), content, document.version, offset);
        if (!lsDoc) return [];

        const stylesheet = cssService.parseStylesheet(lsDoc);
        const lsPosition = lsDoc.positionAt(offset);
        const lsItems = cssService.doComplete(lsDoc, lsPosition, stylesheet).items;

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
                // insertTextFormat 2 = Snippet, wrap in SnippetString so $1/$0 work correctly
                vsItem.insertText = item.insertTextFormat === InsertTextFormat.Snippet
                    ? new vscode.SnippetString(insertText)
                    : insertText;
            }

            if (item.filterText) vsItem.filterText = item.filterText;
            if (item.sortText) vsItem.sortText = item.sortText;

            return vsItem;
        });
    }
}