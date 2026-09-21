import * as vscode from 'vscode';
import { doComplete, VSCodeEmmetConfig } from '@vscode/emmet-helper';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { getZone } from '../utils/zoneUtils';

/**
 * Emmet abbreviations in the suggest widget, offered only where the caret is
 * really markup or CSS.
 *
 * The obvious way to get Emmet into an .asp file is `emmet.includeLanguages`
 * mapping `asp` to `html`, which registers Emmet's own completion provider for
 * the language. That mapping is per LANGUAGE and has no notion of where in the
 * page the caret is, so it offers abbreviations inside `<% %>` as readily as in
 * the markup — and `Response.CharSet` has exactly the shape of Emmet's
 * tag.class shorthand, so taking the suggestion turns working VBScript into
 * `<Response class="CharSet"></Response>`.
 *
 * What looks like it saves that case is a heuristic inside Emmet: from the
 * caret it scans back at most 500 characters, and a `<` found first means "this
 * is inside a tag, refuse" while a `>` found first means "this is after a tag,
 * go ahead". A bare `<% … %>` block trips the `<` rule, which is why the plain
 * case behaves. It is not a rule about ASP, though, and VBScript breaks it
 * constantly — measured in a real Extension Host, Emmet offers an expansion
 * inside `<% %>` after any of:
 *
 *     If x > 0 Then            ' a comparison
 *     If x <> 0 Then           ' scanning back finds the > first
 *     Response.Write "<div>"   ' a tag inside a string
 *     ' an arrow -> in a comment
 *
 * and unconditionally once the block runs past the 500-character window.
 *
 * So the mapping is left unset and the expansions are produced here instead,
 * from `@vscode/emmet-helper` — the same library Emmet's own extension calls
 * into, so the abbreviations and their output are identical. What changes is
 * who decides where they apply: `getZone`, which reads the page the way the
 * engine does, rather than a backwards scan for a stray angle bracket.
 */

/** Reads the Emmet settings the helper understands, for this document. */
function emmetConfig(uri: vscode.Uri): VSCodeEmmetConfig {
    const config = vscode.workspace.getConfiguration('emmet', uri);
    return {
        showExpandedAbbreviation:    config.get<string>('showExpandedAbbreviation'),
        showAbbreviationSuggestions: config.get<boolean>('showAbbreviationSuggestions'),
        showSuggestionsAsSnippets:   config.get<boolean>('showSuggestionsAsSnippets'),
        syntaxProfiles:              config.get<object>('syntaxProfiles'),
        variables:                   config.get<object>('variables'),
        preferences:                 config.get<object>('preferences'),
        excludeLanguages:            config.get<string[]>('excludeLanguages'),
    };
}

/**
 * Converts one of the helper's LSP completion items to a VS Code one.
 *
 * Every item Emmet produces is a snippet, and the text lives in `textEdit`
 * rather than in `insertText` — the range matters, because an abbreviation
 * extends back over characters the widget does not consider part of the word.
 */
function toCompletionItem(item: any): vscode.CompletionItem {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    const converted = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);

    const edit = item.textEdit;
    const newText = edit?.newText ?? item.insertText ?? label;
    converted.insertText = new vscode.SnippetString(newText);

    if (edit?.range) {
        converted.range = new vscode.Range(
            edit.range.start.line, edit.range.start.character,
            edit.range.end.line,   edit.range.end.character,
        );
    }

    if (item.detail)        { converted.detail        = item.detail; }
    if (item.documentation) {
        converted.documentation = typeof item.documentation === 'string'
            ? item.documentation
            : item.documentation.value;
    }
    if (item.filterText)    { converted.filterText    = item.filterText; }
    if (item.sortText)      { converted.sortText      = item.sortText; }

    return converted;
}

export class EmmetCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionList | undefined {
        const config = emmetConfig(document.uri);
        if (config.showExpandedAbbreviation === 'never') { return; }
        if (config.excludeLanguages?.includes(document.languageId)) { return; }

        // The whole point of this provider: the zone decides, not the text
        // around the caret. `asp` is VBScript and `js` belongs to the embedded
        // TypeScript service — expanding an abbreviation in either would
        // replace working code with markup.
        const zone = getZone(document.getText(), document.offsetAt(position));
        if (zone !== 'html' && zone !== 'css') { return; }
        const syntax = zone === 'css' ? 'css' : 'html';

        // The helper reads an LSP document. Its own language id is what it uses
        // to tell a stylesheet from markup, so it is given the ZONE's syntax
        // rather than `asp`, which it has never heard of.
        const lsDocument = LsTextDocument.create(
            document.uri.toString(), syntax, document.version, document.getText(),
        );

        const list = doComplete(
            lsDocument, { line: position.line, character: position.character }, syntax, config,
        );
        if (!list?.items.length) { return; }

        // Incomplete, so the widget re-queries as the abbreviation grows: what
        // `ul>li` expands to is nothing like what `ul>li*3` expands to, and a
        // cached list would keep offering the first.
        return new vscode.CompletionList(list.items.map(toCompletionItem), true);
    }
}
