/**
 * aspFeatures.ts  (asp/)
 *
 * Registers the VBScript editor features of an ASP page: completion, hover,
 * Go to Definition, references, rename, the Outline, signature help, Ctrl+T,
 * and the #include path completion and links.
 */

import * as vscode from 'vscode';
import { guarded } from '../platform/guardedProvider';
import { AspCompletionProvider } from './aspCompletionProvider';
import { AspDefinitionProvider } from './aspDefinitionProvider';
import { AspDocumentSymbolProvider } from './aspDocumentSymbolProvider';
import { AspHoverProvider } from './aspHoverProvider';
import { AspReferenceProvider, AspRenameProvider, registerIncludeUpdatesOnRename } from './aspRenameProvider';
import { AspSignatureHelpProvider } from './aspSignatureHelpProvider';
import { AspWorkspaceSymbolProvider } from './aspWorkspaceSymbolProvider';
import { registerIncludeGraph } from './includeGraph';
import { IgnoreCodeActionProvider } from '../platform/ignoreActions';
import { IncludePathCompletionProvider, preloadIncludeSymbols, watchIncludeChanges } from './includeProvider';
import { IncludeDocumentLinkProvider } from '../html/linkProvider';
import { PATH_TRIGGER_CHARACTERS } from '../platform/pathCompletion';

function preloadIncludes(document: vscode.TextDocument | undefined): void {
    if (document?.languageId === 'asp') {
        void preloadIncludeSymbols(document);
    }
}

export function registerAspFeatures(context: vscode.ExtensionContext): void {
    // The include symbols are read on a worker as soon as a page is in view, so
    // completion has them by the time it is asked.
    preloadIncludes(vscode.window.activeTextEditor?.document);
    // Which pages include which, read in the background for F12, hover and rename.
    registerIncludeGraph(context);
    context.subscriptions.push(...watchIncludeChanges());

    context.subscriptions.push(
        // "Ignore on this line" / "Ignore in this file" for any of this extension's problems.
        vscode.languages.registerCodeActionsProvider(
            'asp', guarded('Ignore actions', new IgnoreCodeActionProvider()),
            { providedCodeActionKinds: IgnoreCodeActionProvider.kinds },
        ),
        vscode.workspace.onDidOpenTextDocument(preloadIncludes),
        vscode.window.onDidChangeActiveTextEditor(editor => preloadIncludes(editor?.document)),

        vscode.languages.registerCompletionItemProvider(
            'asp', guarded('AspCompletionProvider', new AspCompletionProvider()), '.', ' ',
        ),
        vscode.languages.registerCompletionItemProvider(
            'asp', guarded('IncludePathCompletionProvider', new IncludePathCompletionProvider()), ...PATH_TRIGGER_CHARACTERS,
        ),
        vscode.languages.registerDocumentLinkProvider(
            'asp', guarded('IncludeDocumentLinkProvider', new IncludeDocumentLinkProvider()),
        ),

        // Go to Definition — the JS provider (js/jsFeatures) declines this zone,
        // and this one declines the JS zone.
        vscode.languages.registerDefinitionProvider(
            'asp', guarded('AspDefinitionProvider', new AspDefinitionProvider()),
        ),

        // Without these VS Code matches the word as plain TEXT, so a `total` inside
        // a string or a comment highlights as though it were the variable.
        vscode.languages.registerReferenceProvider(
            'asp', guarded('AspReferenceProvider', new AspReferenceProvider()),
        ),
        vscode.languages.registerRenameProvider(
            'asp', guarded('AspRenameProvider', new AspRenameProvider(), { userErrors: ['prepareRename', 'provideRenameEdits'] }),
        ),
        registerIncludeUpdatesOnRename(),

        vscode.languages.registerDocumentSymbolProvider(
            'asp', guarded('AspDocumentSymbolProvider', new AspDocumentSymbolProvider()), { label: 'VBScript' },
        ),
        vscode.languages.registerSignatureHelpProvider(
            'asp',
            guarded('AspSignatureHelpProvider', new AspSignatureHelpProvider()),
            { triggerCharacters: ['('], retriggerCharacters: [','] },
        ),
        vscode.languages.registerHoverProvider(
            'asp', guarded('AspHoverProvider', new AspHoverProvider()),
        ),

        // Workspace symbol search (Ctrl+T).
        vscode.languages.registerWorkspaceSymbolProvider(
            guarded('AspWorkspaceSymbolProvider', new AspWorkspaceSymbolProvider()),
        ),
    );
}
