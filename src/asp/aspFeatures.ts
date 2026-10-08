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
import { AspWorkspaceSymbolProvider, clearWorkspaceSymbolCache } from './aspWorkspaceSymbolProvider';
import { forgetIncludeFile, IncludePathCompletionProvider, preloadIncludeSymbols } from './includeProvider';
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

    context.subscriptions.push(
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
            'asp', guarded('AspDocumentSymbolProvider', new AspDocumentSymbolProvider()),
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
        // languageId, not the file extension: the document is open, so VS Code has
        // already classified it — including through the user's own files.associations.
        // Matching /\.(asp|inc)$/ meant a Classic ASP library kept in a .html file
        // never invalidated either cache on save, so edits to it stayed invisible
        // until the window was reloaded.
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.languageId === 'asp') {
                clearWorkspaceSymbolCache(doc.uri.fsPath);
                forgetIncludeFile(doc.uri.fsPath);
            }
        }),
    );
}
