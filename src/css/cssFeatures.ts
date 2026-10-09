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

// One pending re-trigger at a time, so moving the caret faster than its 50 ms
// delay does not queue several.
let styleTimeout: ReturnType<typeof setTimeout> | undefined;

/** Opens the CSS suggestions when the caret lands inside an empty style="". */
function suggestInEmptyStyle(event: vscode.TextEditorSelectionChangeEvent): void {
    const doc = event.textEditor.document;
    if (doc.languageId !== 'asp') return;
    if (event.selections.length !== 1 || !event.selections[0].isEmpty) return;

    // Only the text around the caret is read: this runs on every cursor
    // move, and asking for the whole page made the editor copy all of it.
    const caret       = event.selections[0].active;
    const offset      = doc.offsetAt(caret);
    const searchStart = Math.max(0, offset - 200);
    const before      = doc.getText(new vscode.Range(doc.positionAt(searchStart), caret));
    const match       = before.match(/style\s*=\s*(["'])([\s\S]*)$/i);
    if (!match) return;

    const valueStart = searchStart + match.index! + match[0].length - match[2].length;
    const next       = doc.getText(new vscode.Range(caret, doc.positionAt(offset + 1)));
    if (next === match[1] && offset === valueStart) {
        clearTimeout(styleTimeout);
        styleTimeout = setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 50);
    }
}

export function registerCssFeatures(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        // Trigger chars are limited to punctuation that genuinely starts or
        // continues a CSS token. The a-z letters are left out — the zone check
        // inside CssCompletionProvider already guards every call, so VS Code's
        // word-based activation is enough to keep completions flowing while the
        // user is typing a property or value name. Letter triggers called the
        // provider on every keystroke anywhere in the file, not just in CSS.
        vscode.languages.registerCompletionItemProvider(
            'asp', guarded('CssCompletionProvider', new CssCompletionProvider()),
            ':', ';', '-', ' ', '{', '(',
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
