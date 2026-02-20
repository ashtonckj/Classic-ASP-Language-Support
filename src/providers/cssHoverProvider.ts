import * as vscode from 'vscode';
import { getCSSLanguageService } from 'vscode-css-languageservice';
import { getZone, buildCssDoc } from './cssUtils';

const cssService = getCSSLanguageService();

export class CssHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | null {
        const content = document.getText();
        const offset = document.offsetAt(position);

        // Only fire inside a <style> block
        if (getZone(content, offset) !== 'css') return null;

        const lsDoc = buildCssDoc(document.uri.toString(), content, document.version, offset);
        if (!lsDoc) return null;

        const stylesheet = cssService.parseStylesheet(lsDoc);
        const lsPosition = lsDoc.positionAt(offset);
        const hover = cssService.doHover(lsDoc, lsPosition, stylesheet);
        if (!hover) return null;

        const contents = typeof hover.contents === 'string'
            ? new vscode.MarkdownString(hover.contents)
            : Array.isArray(hover.contents)
                ? new vscode.MarkdownString(hover.contents.map(c =>
                    typeof c === 'string' ? c : c.value
                ).join('\n\n'))
                : new vscode.MarkdownString(hover.contents.value);

        return new vscode.Hover(contents);
    }
}