import * as vscode from 'vscode';
import * as fs from 'fs';
import { collectAllSymbols } from './includeProvider';
import { isCursorInHtmlFileLinkAttribute } from '../utils/htmlLinkUtils';
import { getZone } from '../utils/zoneUtils';
import { isInsideVbStringOrComment, indexOfWholeWord } from '../utils/documentHelper';

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
        if (isCursorInHtmlFileLinkAttribute(lineText, position.character)) return null;

        // Only resolve VBScript symbols when the cursor is actually in VBScript.
        // Without this, Ctrl+Click on a matching word in plain HTML text, in a
        // client-side <script> (a JS variable), or inside a VBScript string/comment
        // wrongly jumped to the VBScript definition.
        const fullText = document.getText();
        const offset   = document.offsetAt(position);
        if (getZone(fullText, offset) !== 'asp') return null;
        if (isInsideVbStringOrComment(lineText, position.character)) return null;

        // VBScript symbol lookup
        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const word    = document.getText(wordRange).toLowerCase();
        const symbols = collectAllSymbols(document);

        // Functions/Subs/Properties take priority, then variables, constants, and
        // COM object vars. (Kind-collision disambiguation beyond this order is a
        // future refinement.)
        for (const fn of symbols.functions) {
            if (fn.name.toLowerCase() === word) { return this.locationFor(document, fn.filePath, fn.line, fn.name); }
        }
        for (const v of symbols.variables) {
            if (v.name.toLowerCase() === word) { return this.locationFor(document, v.filePath, v.line, v.name); }
        }
        for (const c of symbols.constants) {
            if (c.name.toLowerCase() === word) { return this.locationFor(document, c.filePath, c.line, c.name); }
        }
        for (const cv of symbols.comVariables) {
            if (cv.name.toLowerCase() === word) { return this.locationFor(document, cv.filePath, cv.line, cv.name); }
        }

        return null;
    }

    // Builds a Location pointing at the identifier itself (not column 0) so the
    // editor highlights the name on navigation. Reads the target line from the
    // open document when possible, otherwise from disk (for #include'd files).
    private locationFor(
        document: vscode.TextDocument,
        filePath: string,
        line: number,
        name: string,
    ): vscode.Location {
        const uri      = vscode.Uri.file(filePath);
        const lineText = this.readLine(document, filePath, line);
        const col      = lineText ? indexOfWholeWord(lineText, name) : -1;

        return col >= 0
            ? new vscode.Location(uri, new vscode.Range(line, col, line, col + name.length))
            : new vscode.Location(uri, new vscode.Position(line, 0));
    }

    private readLine(document: vscode.TextDocument, filePath: string, line: number): string | null {
        if (document.uri.fsPath.toLowerCase() === filePath.toLowerCase()) {
            return line >= 0 && line < document.lineCount ? document.lineAt(line).text : null;
        }
        try {
            return fs.readFileSync(filePath, 'utf8').split(/\r?\n/)[line] ?? null;
        } catch {
            return null;
        }
    }
}