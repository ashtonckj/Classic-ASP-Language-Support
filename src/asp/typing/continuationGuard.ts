/**
 * continuationGuard.ts  (asp/typing/)
 *
 * No suggestions on the `_` that continues a VBScript line.
 */

import * as vscode from 'vscode';
import { endsWithContinuation } from '../../core/vbLexical';
import { aspCodeStartOnLine } from '../../platform/documentHelper';

// ── Suppress suggestions on line-continuation _ ───────────────────────────
// onDidChangeTextDocument fires synchronously after every edit, before VS Code
// has a chance to show the (stale) cached completion list.  If the typed char
// is _ and it continues the line, as the parser's lexer reads it, we immediately
// call hideSuggestWidget so the popup never appears.

export function registerLineContinuationGuard(context: vscode.ExtensionContext) {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) { return; }
        if (event.document.languageId !== 'asp')           { return; }
        if (event.contentChanges.length === 0)             { return; }

        const change = event.contentChanges[0];

        // Only care when the character typed was _
        if (change.text !== '_') { return; }

        const lineNo    = change.range.start.line;
        const line      = event.document.lineAt(lineNo);
        // Text up to and including the newly typed _
        const lineUpTo  = line.text.substring(0, change.range.start.character + 1);

        if (endsWithContinuation(lineUpTo, aspCodeStartOnLine(lineUpTo, lineUpTo.length))) {
            // Hide the suggestion widget. We fire twice — once immediately
            // (catches the cached list) and once after a short delay (catches
            // the freshly-invoked list that VS Code may show after the edit).
            vscode.commands.executeCommand('hideSuggestWidget');
            setTimeout(() => vscode.commands.executeCommand('hideSuggestWidget'), 50);
        }
    });

    context.subscriptions.push(disposable);
}
