/**
 * cssFeatures.ts  (css/)
 *
 * Registers the CSS features of an ASP page, in <style> blocks and style=""
 * attributes alike: completion, hover, and the colour swatches and picker.
 */

import * as vscode from 'vscode';
import { guarded } from '../platform/guardedProvider';
import { CssCompletionProvider } from './cssCompletionProvider';
import { CssHoverProvider } from './cssHoverProvider';
import { CssColorProvider } from './cssColorProvider';
import { styleAttributeAt } from './cssUtils';
import { zonesFor } from '../platform/documentState';

// One pending re-trigger at a time, so moving the caret faster than its 50 ms
// delay does not queue several.
let styleTimeout: ReturnType<typeof setTimeout> | undefined;

/** Opens the CSS suggestions when the caret lands inside an empty style="". */
function suggestInEmptyStyle(event: vscode.TextEditorSelectionChangeEvent): void {
    const doc = event.textEditor.document;
    if (doc.languageId !== 'asp') return;
    if (event.selections.length !== 1 || !event.selections[0].isEmpty) return;

    // The zones are read once per version, so this costs a lookup per cursor move.
    const offset = doc.offsetAt(event.selections[0].active);
    const value  = styleAttributeAt(zonesFor(doc), offset);
    if (value && value.start === value.end) {
        clearTimeout(styleTimeout);
        styleTimeout = setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 50);
    }
}

export function registerCssFeatures(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        // VS Code's own CSS support triggers on these alone; typing a word opens
        // the list as usual. `{`, `;` and space also opened it, so the Enter
        // after `.a {` took `display` instead of starting a new line.
        vscode.languages.registerCompletionItemProvider(
            'asp', guarded('CssCompletionProvider', new CssCompletionProvider()),
            '/', '-', ':',
        ),
        vscode.window.onDidChangeTextEditorSelection(suggestInEmptyStyle),

        vscode.languages.registerHoverProvider(
            'asp', guarded('CssHoverProvider', new CssHoverProvider()),
        ),

        // A .css or .html file shows a square beside every colour and opens a picker
        // on click; an ASP page showed nothing, in <style> blocks or style="" alike.
        vscode.languages.registerColorProvider(
            'asp', guarded('CssColorProvider', new CssColorProvider()),
        ),
    );
}
