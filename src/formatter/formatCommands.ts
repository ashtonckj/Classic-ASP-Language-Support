/**
 * formatCommands.ts  (formatter/)
 *
 * Format Document, Format Selection and Classic ASP: Preview Formatting — the
 * editor side of the formatter. The formatter itself (htmlFormatter.formatPage)
 * only works out the text, or why it would not; what the user is told, and when,
 * is decided here.
 */

import * as vscode from 'vscode';
import { formatPage, type FormatResult } from './htmlFormatter';
import { scanHtmlStructure } from '../html/htmlStructureDiagnosticsProvider';
import { scanAspStructure, scanAspTags } from '../asp/aspStructureDiagnosticsProvider';
import { computeLineEdits, computeRangeEdits, resolveEol, toLf } from '../platform/editUtils';
import { prettierSettings } from '../platform/settings';
import { log, showLog } from '../platform/log';
import { guarded } from '../platform/guardedProvider';
import type { ReviewPrompt } from '../platform/reviewPrompt';

export interface FormattingDeps {
    /** The structure diagnostics, refreshed by every format so the squiggles agree with its answer. */
    htmlStructure: vscode.DiagnosticCollection;
    aspStructure:  vscode.DiagnosticCollection;
    /** Asks for a rating, rarely, after a format that worked. */
    reviewPrompt:  ReviewPrompt;
}

// The structure problems are scanned again here rather than read back from the
// diagnostic collections. Those are filled by a debounced pass, so reading them
// answered from whatever the last tick happened to hold: a file opened and
// formatted inside the debounce window was formatted even though it was broken,
// and a file whose last problem had just been fixed was still refused, quoting
// an issue that no longer existed.
function structureIssueCount(document: vscode.TextDocument, deps: FormattingDeps): number {
    const htmlIssues = scanHtmlStructure(document);
    const aspIssues  = [...scanAspTags(document), ...scanAspStructure(document)];

    deps.htmlStructure.set(document.uri, htmlIssues);
    deps.aspStructure.set(document.uri,  aspIssues);

    return htmlIssues.length + aspIssues.length;
}

/** Tells the user why a page was not formatted. */
function reportRefusal(result: Exclude<FormatResult, { ok: true }>): void {
    if (result.details) {
        log.error(result.details);
        showLog();
    }
    if (result.severity === 'info') {
        void vscode.window.showInformationMessage(result.message);
    } else {
        void vscode.window.showWarningMessage(result.message);
    }
}

/**
 * The page as it is and as formatting would leave it — or undefined, with the
 * user told why, when it cannot be formatted. Both are LF-normalised, so a
 * CRLF-saved file is not reported as "every line changed"; the edits are
 * written back with the line ending resolveEol picks.
 */
async function formatForDocument(
    document: vscode.TextDocument,
    deps: FormattingDeps,
): Promise<{ fullText: string; formatted: string } | undefined> {
    const total = structureIssueCount(document, deps);
    if (total > 0) {
        void vscode.window.showWarningMessage(
            `Formatting skipped — ${total} structure issue${total === 1 ? '' : 's'} found. `
            + 'Fix the highlighted warnings first.',
            'Show Problems',
        ).then(choice => {
            if (choice === 'Show Problems') {
                void vscode.commands.executeCommand('workbench.actions.view.problems');
            }
        });
        return undefined;
    }

    const fullText = toLf(document.getText());
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Classic ASP: Formatting…', cancellable: false },
        () => formatPage(fullText),
    );
    if (!result.ok) {
        reportRefusal(result);
        return undefined;
    }

    void deps.reviewPrompt.formatted();
    return { fullText, formatted: toLf(result.text) };
}

// Opens VS Code's built-in diff editor showing current vs formatted.
// Nothing is applied to the real file — purely a visual preview.
async function openFormattingPreview(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    formatted: string,
): Promise<void> {
    const previewUri   = document.uri.with({ scheme: 'asp-format-preview' });
    const provider     = new (class implements vscode.TextDocumentContentProvider {
        provideTextDocumentContent() { return formatted; }
    })();
    const registration = vscode.workspace.registerTextDocumentContentProvider('asp-format-preview', provider);

    await vscode.commands.executeCommand(
        'vscode.diff',
        document.uri,
        previewUri,
        `Formatting Preview — ${document.fileName.split(/[\\/]/).pop()}`,
        { preview: true },
    );

    const listener = vscode.window.onDidChangeVisibleTextEditors(() => {
        const still = vscode.window.visibleTextEditors.some(
            e => e.document.uri.toString() === previewUri.toString(),
        );
        if (!still) { registration.dispose(); listener.dispose(); }
    });

    context.subscriptions.push(registration, listener);
}

export function registerFormatting(context: vscode.ExtensionContext, deps: FormattingDeps): void {
    const formatter = vscode.languages.registerDocumentFormattingEditProvider('asp', guarded('Format Document', {
        async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
            const result = await formatForDocument(document, deps);
            if (!result) { return []; }

            const eol = resolveEol(prettierSettings().endOfLine, document);
            return computeLineEdits(document, result.fullText, result.formatted, eol);
        },
    }));

    // ── Format Selection (Ctrl+K Ctrl+F) ──────────────────────────────────────
    // What Format Document would do, kept to the selected lines; see
    // computeRangeEdits for why the whole page is formatted to get it.
    const rangeFormatter = vscode.languages.registerDocumentRangeFormattingEditProvider('asp', guarded('Format Selection', {
        async provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.TextEdit[]> {
            const result = await formatForDocument(document, deps);
            if (!result) { return []; }

            const eol = resolveEol(prettierSettings().endOfLine, document);
            const edits = computeRangeEdits(document, result.fullText, result.formatted, eol, range);
            if (!edits) {
                void vscode.window.showInformationMessage(
                    'Formatting changes too much of this page to format just the selection — use Format Document.',
                );
                return [];
            }
            return edits;
        },
    }));

    // ── Classic ASP: Preview Formatting ───────────────────────────────────────
    // A diff of what Format Document would change, with nothing applied. This
    // was the formatPreview setting, which turned Format Document itself into a
    // preview until the setting was switched off again.
    const previewFormatting = vscode.commands.registerCommand('classicAsp.previewFormatting', async () => {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || document.languageId !== 'asp') { return; }

        const result = await formatForDocument(document, deps);
        if (!result) { return; }
        if (result.formatted === result.fullText) {
            void vscode.window.showInformationMessage('No formatting changes — file is already formatted.');
            return;
        }
        await openFormattingPreview(context, document, result.formatted);
    });

    context.subscriptions.push(formatter, rangeFormatter, previewFormatting);
}
