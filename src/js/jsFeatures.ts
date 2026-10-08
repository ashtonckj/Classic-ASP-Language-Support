/**
 * jsFeatures.ts  (js/)
 *
 * Registers the JavaScript features of an ASP page's <script> blocks:
 * completion, hover, signature help, Go to Definition, references and
 * highlights, rename, the Outline, and the quick fixes for the JS squiggles.
 */

import * as vscode from 'vscode';
import { guarded } from '../platform/guardedProvider';
import { JsCompletionProvider } from './jsCompletionProvider';
import { JsHoverProvider } from './jsHoverProvider';
import { JsSignatureHelpProvider } from './jsSignatureHelpProvider';
import { JsDefinitionProvider } from './jsDefinitionProvider';
import { JsReferenceProvider, JsDocumentHighlightProvider } from './jsReferenceProvider';
import { JsRenameProvider } from './jsRenameProvider';
import { JsDocumentSymbolProvider } from './jsDocumentSymbolProvider';
import { JsCodeActionProvider } from './jsCodeActionProvider';

export function registerJsFeatures(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        // '.' triggers member access completions; '(' completions after a
        // function name. Letter/digit triggers are left out — VS Code's own
        // word-based filter narrows the returned list as the user types on.
        vscode.languages.registerCompletionItemProvider(
            'asp', guarded('JsCompletionProvider', new JsCompletionProvider()), '.', '(',
        ),
        vscode.languages.registerHoverProvider(
            'asp', guarded('JsHoverProvider', new JsHoverProvider()),
        ),
        vscode.languages.registerSignatureHelpProvider(
            'asp',
            guarded('JsSignatureHelpProvider', new JsSignatureHelpProvider()),
            { triggerCharacters: ['('], retriggerCharacters: [','] },
        ),
        vscode.languages.registerDefinitionProvider(
            'asp', guarded('JsDefinitionProvider', new JsDefinitionProvider()),
        ),
        vscode.languages.registerReferenceProvider(
            'asp', guarded('JsReferenceProvider', new JsReferenceProvider()),
        ),
        vscode.languages.registerDocumentHighlightProvider(
            'asp', guarded('JsDocumentHighlightProvider', new JsDocumentHighlightProvider()),
        ),
        vscode.languages.registerRenameProvider(
            'asp', guarded('JsRenameProvider', new JsRenameProvider(), { userErrors: ['prepareRename', 'provideRenameEdits'] }),
        ),
        vscode.languages.registerDocumentSymbolProvider(
            'asp', guarded('JsDocumentSymbolProvider', new JsDocumentSymbolProvider()),
        ),
        // Turns the JS squiggles into something actionable — a misspelt DOM member
        // reports "Did you mean 'getElementById'?", and TypeScript supplies the edit.
        vscode.languages.registerCodeActionsProvider(
            'asp', guarded('JsCodeActionProvider', new JsCodeActionProvider()),
            { providedCodeActionKinds: JsCodeActionProvider.providedCodeActionKinds },
        ),
    );
}
