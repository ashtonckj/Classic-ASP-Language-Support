/**
 * aspStructureDiagnosticsProvider.ts
 *
 * Reports VBScript blocks that are never closed, and closing keywords with no
 * block to close, as Warning diagnostics (orange squiggles):
 *
 *   If → End If, For / For Each → Next, While → Wend, Do → Loop,
 *   With → End With, Select Case → End Select, Sub / Function / Property →
 *   End Sub / End Function / End Property, Class → End Class
 *
 * The blocks come from the VBScript syntax tree (src/vbscript), so strings,
 * comments, one-line Ifs, `_` continuations and HTML around the code need no
 * special cases here. Format Document refuses to run while any of these is
 * reported, which is why only block structure is reported, not every error
 * the parser finds.
 *
 * Also here: the `<% %>` balance, missing include files and a missing Set.
 * Debounced at 1500 ms so it doesn't fire on every keystroke.
 */

import * as vscode from 'vscode';
import { onSettingsChange } from '../platform/settings';
import * as fs from 'fs';
import { aspTagProblems } from '../core/zoneUtils';
import { textOf, zonesFor } from '../platform/documentState';
import { DiagnosticCode, makeDiagnostic } from '../platform/diagnostics';
import { parseIncludeDirectives, resolveIncludeDirective } from '../core/includeDirectives';
import { parsePage } from '../vbscript/symbols';
import { pageBlocks, type BlockWarning, type MissingSet } from '../vbscript/pageAnalysis';
import { analysedPage, checkedPage } from './vbscriptWorkspace';
import { areIncludeSymbolsReady, configuredVirtualRoot, preloadIncludeSymbols } from './includeProvider';
import { parserCheckDiagnostics } from './aspChecksProvider';

// ── Block warnings ────────────────────────────────────────────────────────────
// "Missing End If" and "End If with no If", read from the syntax tree
// (vbscript/pageAnalysis.ts). After an edit they come from the VBScript worker
// thread, with the matching-keyword highlight; Format Document reads them here,
// since it must answer for exactly the text it is about to change.

/** The warnings as diagnostics on `document`, whose text they were read from. */
export function blockDiagnostics(document: vscode.TextDocument, warnings: BlockWarning[]): vscode.Diagnostic[] {
    return warnings.map(w => makeDiagnostic(
        new vscode.Range(document.positionAt(w.start), document.positionAt(w.end)), w.message,
        vscode.DiagnosticSeverity.Warning, DiagnosticCode.vbscriptBlock,
    ));
}

export function scanAspStructure(document: vscode.TextDocument): vscode.Diagnostic[] {
    return blockDiagnostics(document, pageBlocks(parsePage(textOf(document))).warnings);
}

// ── ASP tag balance scanner ───────────────────────────────────────────────────
//
// Checks that every <% has a matching %> and vice versa, across the whole file.
//
// Flagged cases:
//   Stray %>   — no matching <% above it  →  Warning on the %>  (2 chars)
//   Unclosed <% — no matching %> in file  →  Warning on the <%  (2 chars)
export function scanAspTags(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const problem of aspTagProblems(textOf(document), zonesFor(document))) {
        diagnostics.push(makeDiagnostic(
            new vscode.Range(document.positionAt(problem.offset), document.positionAt(problem.offset + 2)),
            problem.kind === 'stray' ? `Unexpected '%>' — no opening '<%' found` : `Unclosed '<%' — no matching '%>' found`,
            vscode.DiagnosticSeverity.Warning, DiagnosticCode.aspTag,
        ));
    }

    return diagnostics;
}

// ── Include files that are not there ──────────────────────────────────────────

/** An #include whose file does not exist: where its path is written, and why. */
export interface MissingInclude {
    start:   number;
    end:     number;
    message: string;
}

function isFile(fsPath: string): boolean {
    try { return fs.statSync(fsPath).isFile(); } catch { return false; }
}

/**
 * Every #include whose file does not exist, resolved the way the include links
 * and symbols resolve it. IIS will not run a page with one — "Include file not
 * found" (ASP 0126) — so a typo in the path stops the whole page, not just the
 * part the include was for.
 *
 * `virtualRoot` is undefined when nothing says where the site starts (no
 * setting, no folder open). A `virtual="/…"` path is then left alone rather
 * than reported missing from a folder that was only a guess.
 */
export function findMissingIncludes(
    text: string,
    documentPath: string,
    virtualRoot: string | undefined,
): MissingInclude[] {
    const missing: MissingInclude[] = [];
    for (const directive of parseIncludeDirectives(text)) {
        if (directive.type === 'virtual' && virtualRoot === undefined) { continue; }

        const fullPath = resolveIncludeDirective(directive, documentPath, virtualRoot ?? '');
        if (isFile(fullPath)) { continue; }

        const start = text.indexOf(directive.raw, directive.index);
        const where = directive.type === 'virtual'
            ? ` A virtual path starts at the site root, ${virtualRoot} — set "classicAsp.virtualRoot" if yours is somewhere else.`
            : '';
        missing.push({
            start,
            end: start + directive.raw.length,
            message: `Include file not found: ${fullPath}. IIS will not run this page (ASP 0126).${where}`,
        });
    }
    return missing;
}

/** Missing-include warnings for a saved page; an untitled one has no folder to look in. */
export function scanIncludes(document: vscode.TextDocument): vscode.Diagnostic[] {
    if (document.uri.scheme !== 'file') { return []; }
    return findMissingIncludes(textOf(document), document.uri.fsPath, configuredVirtualRoot())
        .map(found => makeDiagnostic(
            new vscode.Range(document.positionAt(found.start), document.positionAt(found.end)),
            found.message,
            vscode.DiagnosticSeverity.Warning, DiagnosticCode.missingInclude,
        ));
}

// ── An object assigned without Set ────────────────────────────────────────────

/** The Missing-Set warnings as diagnostics on `document`, whose text they were found in. */
export function missingSetDiagnostics(document: vscode.TextDocument, missingSet: MissingSet[]): vscode.Diagnostic[] {
    return missingSet.map(found => makeDiagnostic(
        new vscode.Range(document.positionAt(found.start), document.positionAt(found.end)),
        `Missing Set: an object is assigned here, so this needs \`Set ${found.target} = …\`. ` +
        `Without Set, VBScript tries to copy the object's default value instead, which fails when the page runs.`,
        vscode.DiagnosticSeverity.Warning, DiagnosticCode.missingSet,
    ));
}

/** The quick fix: `Set` in front of the name, or in place of a `Let`. */
class AddSetQuickFix implements vscode.CodeActionProvider {
    static readonly kinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        return context.diagnostics
            .filter(diagnostic => diagnostic.code === DiagnosticCode.missingSet)
            .map(diagnostic => {
                const start  = diagnostic.range.start;
                const before = document.lineAt(start.line).text.slice(0, start.character);
                const letAt  = /\bLet\s+$/i.exec(before);

                const edit = new vscode.WorkspaceEdit();
                if (letAt) {
                    edit.replace(document.uri, new vscode.Range(start.line, letAt.index, start.line, letAt.index + 3), 'Set');
                } else {
                    edit.insert(document.uri, start, 'Set ');
                }

                const action = new vscode.CodeAction('Add Set', vscode.CodeActionKind.QuickFix);
                action.edit        = edit;
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                return action;
            });
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerAspStructureDiagnostics(
    context: vscode.ExtensionContext
): vscode.DiagnosticCollection {

    const collection = vscode.languages.createDiagnosticCollection('classic-asp-vbscript-structure');
    // Its own collection: a missing include, a missing Set and the parser's
    // checks are worth knowing about, but none is a structure problem, so none
    // may stop Format Document — which refuses to run while `collection` has
    // anything in it.
    const checksCollection = vscode.languages.createDiagnosticCollection('classic-asp-checks');
    context.subscriptions.push(
        collection,
        checksCollection,
        vscode.languages.registerCodeActionsProvider(
            { language: 'asp' }, new AddSetQuickFix(), { providedCodeActionKinds: AddSetQuickFix.kinds },
        ),
    );

    function scanChecks(document: vscode.TextDocument): void {
        // Missing Set and the parser's checks bind the page with its includes,
        // which is worked out on the VBScript worker thread.
        void checkedPage(document).then(checked => {
            if (!checked || document.isClosed || document.version !== checked.version) { return; }
            checksCollection.set(document.uri, [
                ...scanIncludes(document),
                ...missingSetDiagnostics(document, checked.missingSet),
                ...parserCheckDiagnostics(document, checked.checks),
            ]);
        });
    }

    // Per-document debounce timers, keyed by URI, so editing one open .asp file
    // never cancels another file's pending scan (a single shared timer did).
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function scanNow(document: vscode.TextDocument): void {
        void analysedPage(document).then(page => {
            if (!page || document.isClosed || document.version !== page.version) { return; }
            collection.set(document.uri, [...scanAspTags(document), ...blockDiagnostics(document, page.blocks.warnings)]);
        });
        scanChecks(document);

        // Whether `conn` is a Connection may be written in an include, which
        // is still loading the first time a page is scanned.
        if (!areIncludeSymbolsReady(document)) {
            void preloadIncludeSymbols(document).then(() => {
                if (!document.isClosed) { scanChecks(document); }
            });
        }
    }

    function schedule(document: vscode.TextDocument): void {
        if (document.languageId !== 'asp') { return; }
        const key = document.uri.toString();
        const existing = debounceTimers.get(key);
        if (existing) { clearTimeout(existing); }
        debounceTimers.set(key, setTimeout(() => {
            debounceTimers.delete(key);
            scanNow(document);
        }, 1500));
    }

    // An include can appear or go without the page being edited — created,
    // deleted or renamed in the Explorer, or a different site root set.
    function recheckIncludes(): void {
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'asp') { scanChecks(doc); }
        }
    }

    // Run immediately on already-open documents
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'asp') { scanNow(doc); }
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(schedule),
        vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            const existing = debounceTimers.get(key);
            if (existing) { clearTimeout(existing); debounceTimers.delete(key); }
            collection.delete(doc.uri);
            checksCollection.delete(doc.uri);
        }),
        vscode.workspace.onDidCreateFiles(recheckIncludes),
        vscode.workspace.onDidDeleteFiles(recheckIncludes),
        vscode.workspace.onDidRenameFiles(recheckIncludes),
        vscode.workspace.onDidChangeWorkspaceFolders(recheckIncludes),
        onSettingsChange(['classicAsp.virtualRoot'], recheckIncludes),
        // Anything done outside VS Code (a git checkout, a build step) raises
        // none of the above; coming back to the page picks it up.
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor?.document.languageId === 'asp') { scanChecks(editor.document); }
        }),
    );

    // Cancel any pending timers on deactivate.
    context.subscriptions.push({
        dispose: () => {
            for (const timer of debounceTimers.values()) { clearTimeout(timer); }
            debounceTimers.clear();
        },
    });

    return collection;
}