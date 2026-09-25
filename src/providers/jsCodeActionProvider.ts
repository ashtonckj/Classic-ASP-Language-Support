/**
 * jsCodeActionProvider.ts  (providers/)
 *
 * Quick Fixes (Ctrl+.) for JavaScript inside <script> blocks.
 *
 * The squiggles were already there — this turns them into something actionable.
 * A misspelt DOM member reports TS2551, whose message ends "Did you mean
 * 'getElementById'?", and TypeScript can supply the edit that corrects it. In a
 * plain .html file that fix is one keystroke away; in an ASP page there was
 * nothing on the lightbulb at all.
 *
 * Which errors to ask about comes from the diagnostics VS Code already holds for
 * the range, filtered to the ones this extension published. Asking TypeScript
 * for fixes to codes it never reported here would be guesswork, and the
 * suppressed codes (see SUPPRESSED_CODES) deliberately have no squiggle, so they
 * must not acquire a lightbulb either.
 *
 * A fix is offered only when EVERY edit it carries lands inside the document.
 * The virtual file starts with a generated preamble, and a fix that wanted to
 * rewrite part of that — a projected <% %> value, a cross-frame declaration —
 * cannot be applied to the page. Applying the rest and dropping that edit would
 * leave the page half-changed, so the whole fix is withheld instead.
 */

import * as vscode from 'vscode';
import { prepareJsQuery, toDocumentSpan } from '../utils/jsUtils';

/** The diagnostic source jsDiagnosticsProvider stamps on everything it reports. */
const JS_DIAGNOSTIC_SOURCE = 'Classic ASP (JS)';

export class JsCodeActionProvider implements vscode.CodeActionProvider {

    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        range:    vscode.Range | vscode.Selection,
        context:  vscode.CodeActionContext,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.CodeAction[]> {

        const errorCodes = [...new Set(
            context.diagnostics
                .filter(d => d.source === JS_DIAGNOSTIC_SOURCE && typeof d.code === 'number')
                .map(d => d.code as number),
        )];
        if (!errorCodes.length) { return undefined; }

        const start = document.offsetAt(range.start);
        const end   = document.offsetAt(range.end);

        const query = prepareJsQuery(document.getText(), start);
        if (!query || token.isCancellationRequested) { return undefined; }
        const { svc, preambleLength } = query;

        const fixes = svc.getCodeFixes(
            start + preambleLength, end + preambleLength, errorCodes,
        );
        if (!fixes.length || token.isCancellationRequested) { return undefined; }

        const actions: vscode.CodeAction[] = [];

        for (const fix of fixes) {
            const edit = new vscode.WorkspaceEdit();
            let applicable = true;
            let edits = 0;

            for (const change of fix.changes) {
                for (const textChange of change.textChanges) {
                    const span = toDocumentSpan(change.fileName, textChange.span, preambleLength);
                    if (!span) { applicable = false; break; }
                    edit.replace(
                        document.uri,
                        new vscode.Range(
                            document.positionAt(span.start), document.positionAt(span.end),
                        ),
                        textChange.newText,
                    );
                    edits++;
                }
                if (!applicable) { break; }
            }

            if (!applicable || !edits) { continue; }

            const action = new vscode.CodeAction(fix.description, vscode.CodeActionKind.QuickFix);
            action.edit = edit;
            // Tying the action to its diagnostics is what lets VS Code show it on
            // the squiggle rather than only in the full lightbulb menu.
            action.diagnostics = context.diagnostics.filter(
                d => typeof d.code === 'number' && errorCodes.includes(d.code),
            );
            actions.push(action);
        }

        return actions.length ? actions : undefined;
    }
}
