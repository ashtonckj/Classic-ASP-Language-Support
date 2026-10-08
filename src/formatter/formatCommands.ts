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
//
// They block formatting even where an asp-ignore comment hides them from the
// Problems panel: a page whose tags or blocks do not pair up is put back in the
// wrong places, whatever the panel shows.
function structureIssues(document: vscode.TextDocument, deps: FormattingDeps): vscode.Diagnostic[] {
    const htmlIssues = scanHtmlStructure(document);
    const aspIssues  = [...scanAspTags(document), ...scanAspStructure(document)];

    deps.htmlStructure.set(document.uri, htmlIssues);
    deps.aspStructure.set(document.uri,  aspIssues);

    return [...htmlIssues, ...aspIssues].sort((a, b) => a.range.start.compareTo(b.range.start));
}

// ── Format on save says nothing ──────────────────────────────────────────────
// A refusal during format-on-save would pop up on every Ctrl+S of a page that
// cannot be formatted yet, which is most of the time spent fixing it. VS Code
// does not tell a formatter why it was asked, so a refusal waits a moment and
// is not shown when the page was saved meanwhile.

/** When each page last started saving, by URI. */
const savingSince = new Map<string, number>();
const SAVE_WINDOW_MS = 2000;

function watchSaves(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.onWillSaveTextDocument(event => { savingSince.set(event.document.uri.toString(), Date.now()); }),
        vscode.workspace.onDidSaveTextDocument(document => { savingSince.set(document.uri.toString(), Date.now()); }),
    );
}

/** Runs `tell` shortly, unless `document` was being saved: the format came from format-on-save. */
function unlessSaving(document: vscode.TextDocument, tell: () => void): void {
    setTimeout(() => {
        const saved = savingSince.get(document.uri.toString());
        if (saved !== undefined && Date.now() - saved < SAVE_WINDOW_MS) { return; }
        tell();
    }, 300);
}

/** Says which problem stops the format, and where, with a button to go to it. */
function reportStructure(document: vscode.TextDocument, issues: vscode.Diagnostic[]): void {
    const first = issues[0];
    const more  = issues.length - 1;
    const goTo  = 'Go to Issue';
    const panel = 'Show Problems';
    unlessSaving(document, () => {
        void vscode.window.showWarningMessage(
            `Couldn't format this page: line ${first.range.start.line + 1}: ${first.message}`
            + (more > 0 ? ` (and ${more} more problem${more === 1 ? '' : 's'} like it)` : ''),
            goTo, panel,
        ).then(choice => {
            if (choice === goTo) { void goToRange(document, first.range); }
            if (choice === panel) { void vscode.commands.executeCommand('workbench.actions.view.problems'); }
        });
    });
}

/** Selects `range` of `document`, scrolled into view. */
async function goToRange(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Puts the caret at the start of `line` of `document`, scrolled into view. */
function goToLine(document: vscode.TextDocument, line: number): Promise<void> {
    const at = new vscode.Position(Math.min(line, document.lineCount - 1), 0);
    return goToRange(document, new vscode.Range(at, at));
}

/**
 * Tells the user why a page was not formatted. The details (Prettier's own
 * error and the text it was given) go to the log, which opens only from the
 * Show Details button.
 */
function reportRefusal(document: vscode.TextDocument, result: Exclude<FormatResult, { ok: true }>): void {
    if (result.details) { log.error(result.details); }

    const goTo = 'Go to Line';
    const details = 'Show Details';
    const buttons = [...(result.line !== undefined ? [goTo] : []), ...(result.details ? [details] : [])];
    const show = result.severity === 'info' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    unlessSaving(document, () => {
        void show(result.message, ...buttons).then(choice => {
            if (choice === goTo) { void goToLine(document, result.line!); }
            if (choice === details) { showLog(); }
        });
    });
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
    const issues = structureIssues(document, deps);
    if (issues.length > 0) {
        reportStructure(document, issues);
        return undefined;
    }

    const fullText = toLf(document.getText());
    const result = await vscode.window.withProgress(
        // In the status bar: a notification for every format, on save too, was noise.
        { location: vscode.ProgressLocation.Window, title: 'Formatting…' },
        () => formatPage(fullText),
    );
    if (!result.ok) {
        reportRefusal(document, result);
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
    watchSaves(context);

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
