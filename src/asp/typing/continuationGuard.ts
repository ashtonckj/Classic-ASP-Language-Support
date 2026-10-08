/**
 * continuationGuard.ts  (asp/typing/)
 *
 * No suggestions on the `_` that continues a VBScript line.
 */

import * as vscode from 'vscode';
import { endsWithContinuation } from '../../core/vbLexical';

// ── Line-continuation patterns that mean a trailing _ is NOT an identifier ──
// Each pattern matches the text BEFORE the _ on the line (trimmed).
// If any matches, the _ is a line continuation and suggestions must be hidden.
const LINE_CONTINUATION_BEFORE_PATTERNS: RegExp[] = [
    // Assignment:  something =  _
    /=\s*$/,
    // Concatenation operator:  & _   or  + _
    /[&+]\s*$/,
    // Comparison / logical operators:  <> _ , <= _ , >= _ , = _ , And _ , Or _ , Not _
    /(?:<=|>=|<>|<|>|=|And|Or|Not|Xor|Eqv|Imp)\s*$/i,
    // Arithmetic operators:  * _  / _  \ _  Mod _  ^ _  - _
    /(?:\*|\/|\\|Mod|\^|-)\s*$/i,
    // Open paren (argument list continues):  SomeFunc( _
    /\(\s*$/,
    // Comma (argument or array element continues):  arg1, _
    /,\s*$/,
    // After a closing paren/bracket (chained call):  ) _   or  ] _
    /[)\]]\s*$/,
    // Keyword that expects a value to follow:  Then _  Else _  Return _  Call _
    /(?:Then|Else|ElseIf|Return|Call|Set|Let|ReDim|Dim|Private|Public|Const)\s*$/i,
];

/**
 * Returns true when the trailing _ on the given line is a VBScript
 * line-continuation character rather than part of an identifier.
 *
 * Rules:
 *   1. The _ must be preceded by at least one whitespace character
 *      (a bare  _name  at the start of a word is always an identifier).
 *   2. The text before the _ (trimmed) must match at least one of the
 *      known line-continuation context patterns above.
 */
function isLineContinuation(lineTextUpToCursor: string): boolean {
    if (!endsWithContinuation(lineTextUpToCursor)) { return false; }

    const beforeUnderscore = lineTextUpToCursor.replace(/_\s*$/, '').trimEnd();

    // A line that is ONLY _ (or indented _) with nothing before it:
    // e.g. the user is on a blank line and typed _ — treat as continuation.
    if (beforeUnderscore.trim() === '') { return true; }

    return LINE_CONTINUATION_BEFORE_PATTERNS.some(p => p.test(beforeUnderscore));
}

// ── Suppress suggestions on line-continuation _ ───────────────────────────
// onDidChangeTextDocument fires synchronously after every edit, before VS Code
// has a chance to show the (stale) cached completion list.  If the typed char
// is _ and the line context says it's a continuation, we immediately call
// hideSuggestWidget so the popup never appears.

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

        if (isLineContinuation(lineUpTo)) {
            // Hide the suggestion widget. We fire twice — once immediately
            // (catches the cached list) and once after a short delay (catches
            // the freshly-invoked list that VS Code may show after the edit).
            vscode.commands.executeCommand('hideSuggestWidget');
            setTimeout(() => vscode.commands.executeCommand('hideSuggestWidget'), 50);
        }
    });

    context.subscriptions.push(disposable);
}
