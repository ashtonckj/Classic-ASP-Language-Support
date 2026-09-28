import * as vscode from 'vscode';
import { isCursorInHtmlFileLinkAttribute } from '../utils/htmlLinkUtils';
import { getZone } from '../utils/zoneUtils';
import { isInsideVbStringOrComment } from '../utils/documentHelper';
import { definitionSites, resolveAt } from '../vbscript/references';
import { editorWorkspace } from './vbscriptWorkspace';

// ─────────────────────────────────────────────────────────────────────────────
// AspDefinitionProvider
// Handles F12 / Ctrl+Click for VBScript functions, subs, variables, constants,
// classes and class members — across the current file and all #include'd files.
// The parser works out which declaration a name means, so a local `i` goes to
// its own procedure's Dim, not to the first `i` on the page.
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

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const resolved = resolveAt(editorWorkspace(document), document.uri.fsPath, document.offsetAt(wordRange.start));
        if (!resolved) return null;

        const docPath = document.uri.fsPath.toLowerCase();
        return definitionSites(resolved.bound, resolved.target).map(site => site.file.toLowerCase() === docPath
            ? new vscode.Location(document.uri, new vscode.Range(document.positionAt(site.start), document.positionAt(site.end)))
            : new vscode.Location(
                vscode.Uri.file(site.file),
                new vscode.Range(site.line, site.character, site.line, site.character + site.end - site.start),
            ));
    }
}
