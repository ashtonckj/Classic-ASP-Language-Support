/**
 * htmlFeatures.ts  (html/)
 *
 * Registers the markup features of an ASP page: tag and attribute completion,
 * Emmet, hover, the element outline, linked editing of a tag pair, the
 * href/src links and their path completion, and the quick fix for a void
 * element's closing tag.
 */

import * as vscode from 'vscode';
import { guarded } from '../platform/guardedProvider';
import { HtmlCompletionProvider } from './htmlCompletionProvider';
import { EmmetCompletionProvider } from './emmetCompletionProvider';
import { HtmlDocumentSymbolProvider, HtmlHoverProvider, HtmlLinkedEditingProvider } from './htmlLanguageFeatures';
import { HtmlAttributeLinkProvider, HtmlAttributePathCompletionProvider, inLinkValue } from './linkProvider';
import { zonesFor } from '../platform/documentState';
import { VoidElementQuickFixProvider } from './htmlStructureDiagnosticsProvider';
import { PATH_TRIGGER_CHARACTERS } from '../platform/pathCompletion';

// One pending re-trigger at a time, so moving or typing faster than its 50 ms
// delay does not queue several.
let attrPathTimeout: ReturnType<typeof setTimeout> | undefined;

/**
 * Opens the path suggestions while a path is typed inside a link attribute's
 * value: the trigger characters alone miss a value typed after a paste or a
 * deletion.
 */
function suggestPathsWhileTyping(event: vscode.TextDocumentChangeEvent): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) return;
    if (event.document.languageId !== 'asp') return;
    if (event.contentChanges.length === 0) return;

    const change = event.contentChanges[0];
    if (change.text.length !== 1) return;
    const offset = event.document.offsetAt(change.range.start) + 1;
    if (zonesFor(event.document).zoneAt(offset) !== 'html' || !inLinkValue(event.document, offset)) return;

    clearTimeout(attrPathTimeout);
    attrPathTimeout = setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 50);
}

export function registerHtmlFeatures(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            'asp', guarded('HtmlCompletionProvider', new HtmlCompletionProvider()), '<', '/', ' ', '=',
        ),

        // Emmet abbreviations. Registered here rather than through
        // `emmet.includeLanguages`, because that mapping applies to the whole
        // language and would offer markup inside <% %> — see the provider for what
        // Emmet's own guard does and does not catch.
        vscode.languages.registerCompletionItemProvider(
            'asp', guarded('EmmetCompletionProvider', new EmmetCompletionProvider()),
            '!', '.', '}', ':', '*', '$', ']', '/', '>', '-',
            '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        ),

        vscode.languages.registerDocumentLinkProvider(
            'asp', guarded('HtmlAttributeLinkProvider', new HtmlAttributeLinkProvider()),
        ),
        vscode.languages.registerCompletionItemProvider(
            'asp', guarded('HtmlAttributePathCompletionProvider', new HtmlAttributePathCompletionProvider()),
            ...PATH_TRIGGER_CHARACTERS,
        ),
        vscode.workspace.onDidChangeTextDocument(suggestPathsWhileTyping),

        vscode.languages.registerHoverProvider(
            'asp', guarded('HtmlHoverProvider', new HtmlHoverProvider()),
        ),

        // VS Code shows each symbol provider's results as a group of the Outline,
        // named by this label, beside the VBScript and JavaScript ones.
        vscode.languages.registerDocumentSymbolProvider(
            'asp', guarded('HtmlDocumentSymbolProvider', new HtmlDocumentSymbolProvider()), { label: 'HTML' },
        ),

        // VS Code's own feature, as in a .html file: it runs only when the user
        // turns on editor.linkedEditing. Start Linked Editing (Ctrl+Shift+F2)
        // without the setting marks the pair but does not mirror the typing, in a
        // .html file too.
        vscode.languages.registerLinkedEditingRangeProvider(
            'asp', guarded('HtmlLinkedEditingProvider', new HtmlLinkedEditingProvider()),
        ),

        vscode.languages.registerCodeActionsProvider(
            'asp', guarded('VoidElementQuickFixProvider', new VoidElementQuickFixProvider()),
            { providedCodeActionKinds: VoidElementQuickFixProvider.providedCodeActionKinds },
        ),
    );
}
