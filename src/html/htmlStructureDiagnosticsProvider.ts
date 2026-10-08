/**
 * htmlStructureDiagnosticsProvider.ts
 *
 * Reports the mismatched structural HTML tags core/htmlStructure.ts finds as
 * Warning diagnostics, and a closing tag of a void element (`</br>`) as an
 * Error with a quick fix that removes it. Checked a while after the last edit
 * (CHECK_DELAY.structure), not on every keystroke.
 */

import * as vscode from 'vscode';
import { CHECK_DELAY, DiagnosticCode, makeDiagnostic, watchAspDocuments } from '../platform/diagnostics';
import type { BlockEvent } from '../vbscript/pageAnalysis';
import { analyseHtmlStructure } from '../core/htmlStructure';
import { analysedPage } from '../asp/vbscriptWorkspace';

export function scanHtmlStructure(document: vscode.TextDocument, events?: BlockEvent[]): vscode.Diagnostic[] {
    return analyseHtmlStructure(document.getText(), events).issues.map(issue => {
        const isVoid = issue.kind === 'void';
        return makeDiagnostic(
            new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
            issue.message,
            isVoid ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
            isVoid ? DiagnosticCode.htmlVoidClosingTag : DiagnosticCode.htmlTag,
        );
    });
}

// ── Quick-fix code action provider ───────────────────────────────────────────

export class VoidElementQuickFixProvider implements vscode.CodeActionProvider {

    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        _range:   vscode.Range,
        context:  vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        return context.diagnostics
            .filter(d => d.code === DiagnosticCode.htmlVoidClosingTag)
            .map(diag => {
                const tagText = document.getText(diag.range);
                const action  = new vscode.CodeAction(
                    `Remove \`${tagText}\``,
                    vscode.CodeActionKind.QuickFix
                );
                action.edit        = new vscode.WorkspaceEdit();
                action.edit.delete(document.uri, diag.range);
                action.diagnostics = [diag];
                action.isPreferred = true;
                return action;
            });
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerHtmlStructureDiagnostics(
    context: vscode.ExtensionContext
): vscode.DiagnosticCollection {

    const collection = vscode.languages.createDiagnosticCollection('classic-asp-html-structure');
    context.subscriptions.push(collection);

    watchAspDocuments(context, {
        delay: CHECK_DELAY.structure,
        check: document => {
            // The VBScript blocks come from the worker, so the page is not parsed here.
            void analysedPage(document).then(page => {
                if (!page || document.isClosed || document.version !== page.version) { return; }
                collection.set(document.uri, scanHtmlStructure(document, page.blocks.events));
            });
        },
        // At start-up the worker may not be running yet; these pages are parsed here.
        initial: document => collection.set(document.uri, scanHtmlStructure(document)),
        collections: [collection],
    });

    return collection;
}