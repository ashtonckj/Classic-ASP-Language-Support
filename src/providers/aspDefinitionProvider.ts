import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import { isCursorInHtmlFileLinkAttribute } from '../utils/htmlLinkUtils';

// ─────────────────────────────────────────────────────────────────────────────
// AspDefinitionProvider
// Handles F12 / Ctrl+Click for VBScript functions, subs, variables, constants,
// and COM object variables — across the current file and all #include'd files.
//
// HTML attribute links (href, src, etc.) are handled separately in linkProvider.ts.
// The guard below ensures those attribute values never fall through to symbol lookup.
// ─────────────────────────────────────────────────────────────────────────────

export class AspDefinitionProvider implements vscode.DefinitionProvider {

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Definition> {

        const lineText = document.lineAt(position.line).text;

        // Guard: if the cursor is inside an HTML file-link attribute value, always
        // return null. Navigation is handled by HtmlAttributeLinkProvider in
        // linkProvider.ts via the DocumentLink API, which also owns the tooltip.
        // Returning anything here would cause VS Code to show both the symbol hover
        // ("function test — defined in this file") and the link tooltip simultaneously.
        if (isCursorInHtmlFileLinkAttribute(lineText, position.character)) {
            return null;
        }

        // VBScript symbol lookup
        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const word    = document.getText(wordRange).toLowerCase();
        const symbols = collectAllSymbols(document);

        for (const fn of symbols.functions) {
            if (fn.name.toLowerCase() === word)
                return new vscode.Location(vscode.Uri.file(fn.filePath), new vscode.Position(fn.line, 0));
        }
        for (const v of symbols.variables) {
            if (v.name.toLowerCase() === word)
                return new vscode.Location(vscode.Uri.file(v.filePath), new vscode.Position(v.line, 0));
        }
        for (const c of symbols.constants) {
            if (c.name.toLowerCase() === word)
                return new vscode.Location(vscode.Uri.file(c.filePath), new vscode.Position(c.line, 0));
        }
        for (const cv of symbols.comVariables) {
            if (cv.name.toLowerCase() === word)
                return new vscode.Location(vscode.Uri.file(cv.filePath), new vscode.Position(cv.line, 0));
        }

        return null;
    }
}