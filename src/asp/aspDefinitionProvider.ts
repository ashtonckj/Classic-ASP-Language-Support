import * as vscode from 'vscode';
import { contextAt } from '../platform/documentState';
import { definitionSites, resolveAt } from '../vbscript/references';
import { editorWorkspace, siteToLocation } from './vbscriptWorkspace';
import { isBuiltinName } from '../constants/aspKeywords';

// ─────────────────────────────────────────────────────────────────────────────
// AspDefinitionProvider
// Handles F12 / Ctrl+Click for VBScript functions, subs, variables, constants,
// classes and class members — across the current file and all #include'd files.
// The parser works out which declaration a name means, so a local `i` goes to
// its own procedure's Dim, not to the first `i` on the page.
//
// HTML attribute links (href, src, etc.) are handled separately in linkProvider.ts;
// they are markup, which the zone check below keeps out of symbol lookup.
// ─────────────────────────────────────────────────────────────────────────────

export class AspDefinitionProvider implements vscode.DefinitionProvider {

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Definition> {

        const lineText = document.lineAt(position.line).text;

        // Only resolve VBScript symbols when the cursor is actually in VBScript.
        // Without this, Ctrl+Click on a matching word in plain HTML text — an
        // href value, whose link HtmlAttributeLinkProvider owns, among it — in a
        // client-side <script> (a JS variable), or inside a VBScript string/comment
        // wrongly jumped to the VBScript definition.
        const caret = contextAt(document, position);
        if (caret.zone !== 'asp' || caret.inVbStringOrComment) return null;

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        // A built-in, or a member after a dot (`rs.MoveNext`), is not something
        // a page that includes this one declares, so those pages are not asked:
        // F12 runs on every Ctrl+hover.
        const afterDot = wordRange.start.character > 0 && lineText[wordRange.start.character - 1] === '.';
        const askIncluders = !afterDot && !isBuiltinName(lineText.slice(wordRange.start.character, wordRange.end.character).toLowerCase());
        const resolved = resolveAt(editorWorkspace(document), document.uri.fsPath, document.offsetAt(wordRange.start), askIncluders);
        if (!resolved) return null;

        return definitionSites(resolved.bound, resolved.target).map(site => siteToLocation(document, site));
    }
}
