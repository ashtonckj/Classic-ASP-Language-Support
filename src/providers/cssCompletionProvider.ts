import * as vscode from 'vscode';
import { getCSSLanguageService, CompletionItemKind as LsKind } from 'vscode-css-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { getZone, buildCssDoc } from './cssUtils';

const cssService = getCSSLanguageService();

/**
 * Maps vscode-css-languageservice CompletionItemKind (LSP, 1-based)
 * to vscode.CompletionItemKind so the correct icons appear in the suggestion list.
 */
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
        case LsKind.Property:      return vscode.CompletionItemKind.Property;  // wrench icon
        case LsKind.Unit:          return vscode.CompletionItemKind.Unit;
        case LsKind.Value:         return vscode.CompletionItemKind.Value;
        case LsKind.Enum:          return vscode.CompletionItemKind.Enum;
        case LsKind.Keyword:       return vscode.CompletionItemKind.Keyword;
        case LsKind.Snippet:       return vscode.CompletionItemKind.Snippet;
        case LsKind.Color:         return vscode.CompletionItemKind.Color;     // colour swatch icon
        case LsKind.File:          return vscode.CompletionItemKind.File;
        case LsKind.Reference:     return vscode.CompletionItemKind.Reference;
        default:                   return vscode.CompletionItemKind.Property;
    }
}

export class CssCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const content = document.getText();
        const offset = document.offsetAt(position);

        // Only fire inside a <style> block
        if (getZone(content, offset) !== 'css') return [];

        const lsDoc = buildCssDoc(document.uri.toString(), content, document.version, offset);
        if (!lsDoc) return [];

        const stylesheet = cssService.parseStylesheet(lsDoc);
        const lsPosition = lsDoc.positionAt(offset);
        const lsItems = cssService.doComplete(lsDoc, lsPosition, stylesheet).items;

        return lsItems.map(item => {
            const vsItem = new vscode.CompletionItem(item.label, mapKind(item.kind));

            if (item.detail) vsItem.detail = item.detail;
            if (item.documentation) {
                vsItem.documentation = typeof item.documentation === 'string'
                    ? item.documentation
                    : new vscode.MarkdownString(item.documentation.value);
            }
            if (item.insertText) vsItem.insertText = item.insertText;
            if (item.filterText) vsItem.filterText = item.filterText;
            if (item.sortText) vsItem.sortText = item.sortText;

            return vsItem;
        });
    }
}