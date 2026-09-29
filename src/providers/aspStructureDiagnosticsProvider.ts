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
import * as fs from 'fs';
import { createZoneResolver } from '../utils/zoneUtils';
import { parseIncludeDirectives, resolveIncludeDirective } from '../utils/includeDirectives';
import { removeStrings } from '../utils/documentHelper';
import { parsePage } from '../vbscript/symbols';
import { pageBlocks, type BlockWarning, type MissingSet } from '../vbscript/pageAnalysis';
import { analysedPage, checkedPage } from './vbscriptWorkspace';
import { areIncludeSymbolsReady, configuredVirtualRoot, preloadIncludeSymbols } from './includeProvider';
import { parserCheckDiagnostics } from './aspChecksProvider';

type BlockKind =
    | 'if' | 'for' | 'while' | 'do' | 'with'
    | 'function' | 'sub' | 'select' | 'class' | 'property';

// ── Line-continuation joining ─────────────────────────────────────────────────
//
// Returns true when a physical line ends with a VBScript line-continuation (_).
// The _ must be preceded by whitespace to distinguish it from an identifier suffix.
// Also strips trailing VBScript comments before checking (a comment after _ is
// unusual but technically possible, e.g.  someExpr And _  ' continues here).
function endsWithContinuation(lineText: string): boolean {
    // Strip inline comment first
    const withoutComment = removeStrings(lineText).replace(/'.*$/, '');
    return /(?:^|\s)_\s*$/.test(withoutComment);
}

interface LogicalLine {
    text:         string;   // joined physical lines, continuation markers removed
    physicalLine: number;   // physical line index where this logical line STARTS
                            // (used for diagnostic position reporting)
}

/**
 * Joins consecutive physical lines that end with _ into single logical lines.
 * Each resulting LogicalLine carries the physical line number it started on so
 * that diagnostics still point at the correct source location.
 *
 * The trailing ` _` is stripped from each physical line before joining so that
 * classifyLine sees a clean "If ... Then" rather than "If ... Or _".
 */
function joinContinuationLines(lines: string[]): LogicalLine[] {
    const result: LogicalLine[] = [];
    let i = 0;
    while (i < lines.length) {
        const startLine = i;
        let joined = '';
        let inContinuation = false;

        while (i < lines.length) {
            const raw = lines[i];

            // Blank lines between continuation lines are skipped — they are
            // just formatting whitespace.  A blank line only terminates the
            // logical line when we are NOT currently inside a continuation chain
            // (i.e. the previous non-blank line did not end with _).
            if (raw.trim() === '') {
                if (inContinuation) {
                    i++; // skip blank, stay in chain
                    continue;
                } else {
                    // Blank line with no open chain — advance and let the emit
                    // below record it. Pushing here as well produced TWO empty
                    // logical lines for every blank line in the file.
                    i++;
                    break;
                }
            }

            if (endsWithContinuation(raw)) {
                inContinuation = true;
                // Strip the trailing whitespace+_ and append with a space separator
                joined += raw.replace(/\s_\s*$/, ' ');
                i++;
            } else {
                joined += raw;
                i++;
                break;
            }
        }

        // Only emit if we actually have content (avoids duplicate blank entries)
        if (joined.trim() !== '' || !inContinuation) {
            result.push({ text: joined, physicalLine: startLine });
        }
    }
    return result;
}

// ── Classify a single VBScript logical line ───────────────────────────────────
//
// Returns an array of actions to take for this line.  Most lines return [].
// A line can both close one block and open another (e.g. ElseIf...Then).

type LineAction =
    | { type: 'open';  kind: BlockKind; opener: string; colOffset: number }
    | { type: 'close'; kind: BlockKind; closer: string; colOffset: number };

export function classifyLine(raw: string): LineAction[] {
    const stripped = removeStrings(raw);
    const actions: LineAction[] = [];

    // Classify each `:`-separated statement independently, so a one-liner such as
    // `For i = 1 To 10 : Next` is seen as an opener AND a closer (they balance, so
    // no false "Missing Next"). Strings are already removed above, so every `:`
    // here is a real statement separator.
    for (const segment of stripped.split(':')) {
        classifyStatement(segment, raw, actions);
    }
    return actions;
}

// Classifies ONE `:`-separated statement and appends its action (if any).
function classifyStatement(segment: string, raw: string, actions: LineAction[]): void {
    // Drop `.member` accesses before matching so `obj.Do`, `rs.With`, `x.Next` are
    // never read as block keywords — a real block keyword is never preceded by a
    // dot. (Replaced with a space to preserve word boundaries.)
    const lower = segment.toLowerCase().replace(/\.\w+/g, ' ').trim();

    if (!lower) return;

    // ── Closers first (so ElseIf / Else don't leave a phantom open) ───────────

    // End If / End Sub / End Function / End With / End Select / End Class
    const endMatch = lower.match(/^end\s+(if|sub|function|with|select|class|property)\b/);
    if (endMatch) {
        const kindMap: Record<string, BlockKind> = {
            if: 'if', sub: 'sub', function: 'function',
            with: 'with', select: 'select', class: 'class', property: 'property',
        };
        const k = kindMap[endMatch[1]];
        actions.push({ type: 'close', kind: k, closer: `End ${endMatch[1].charAt(0).toUpperCase() + endMatch[1].slice(1)}`, colOffset: 0 });
        return; // End X never also opens something
    }

    // Next — closes For / For Each
    // Guard: "On Error Resume Next" must NOT be treated as a For closer
    if (/^next(\s|$)/.test(lower) && !/resume\s+next/.test(lower)) {
        actions.push({ type: 'close', kind: 'for', closer: 'Next', colOffset: 0 });
        return;
    }

    // Wend — closes While
    if (/^wend(\s|$)/.test(lower)) {
        actions.push({ type: 'close', kind: 'while', closer: 'Wend', colOffset: 0 });
        return;
    }

    // Loop / Loop While / Loop Until — closes Do
    if (/^loop(\s|$)/.test(lower)) {
        actions.push({ type: 'close', kind: 'do', closer: 'Loop', colOffset: 0 });
        return;
    }

    // ElseIf / Else — neither opens nor closes If (they're mid-block)
    if (/^else(if\b|\s|$)/.test(lower)) {
        return;
    }

    // ── Openers ───────────────────────────────────────────────────────────────

    // If ... Then <statement on same line> — single-line If, no End If needed
    // Detected by: has "then" followed by non-whitespace content
    if (/\bif\b.*\bthen\b\s+\S/.test(lower)) {
        return; // single-line If
    }

    // If ... Then (block) — now correctly matches even when If and Then were on
    // separate physical lines and have been joined by joinContinuationLines
    if (/\bif\b.*\bthen\b/.test(lower)) {
        const col = raw.toLowerCase().indexOf('if');
        actions.push({ type: 'open', kind: 'if', opener: 'If', colOffset: col });
        return;
    }

    // Select Case
    if (/\bselect\s+case\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bselect\b/);
        actions.push({ type: 'open', kind: 'select', opener: 'Select Case', colOffset: col });
        return;
    }

    // For Each / For <var> = ...
    if (/\bfor\s+each\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bfor\b/);
        actions.push({ type: 'open', kind: 'for', opener: 'For Each', colOffset: col });
        return;
    }
    if (/\bfor\s+\w+\s*=/.test(lower)) {
        const col = raw.toLowerCase().search(/\bfor\b/);
        actions.push({ type: 'open', kind: 'for', opener: 'For', colOffset: col });
        return;
    }

    // Do / Do While / Do Until — must come BEFORE the While check.
    // Guard: "Exit Do" contains the word "do" but is NOT a block opener.
    if (/\bdo\s+while\b/.test(lower) && !/\bexit\s+do\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bdo\b/);
        actions.push({ type: 'open', kind: 'do', opener: 'Do While', colOffset: col });
        return;
    }
    if (/\bdo\s+until\b/.test(lower) && !/\bexit\s+do\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bdo\b/);
        actions.push({ type: 'open', kind: 'do', opener: 'Do Until', colOffset: col });
        return;
    }
    // Bare "Do" — but NOT "Exit Do"
    if (/\bdo\b(\s|$)/.test(lower) && !/\bexit\s+do\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bdo\b/);
        actions.push({ type: 'open', kind: 'do', opener: 'Do', colOffset: col });
        return;
    }

    // While ... Wend
    // Guard: "Exit While" contains the word "while" but is NOT a block opener.
    if (/\bwhile\b/.test(lower) && !/^loop\b/.test(lower) && !/^do\b/.test(lower) && !/\bexit\s+while\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bwhile\b/);
        actions.push({ type: 'open', kind: 'while', opener: 'While', colOffset: col });
        return;
    }

    // Function <n>
    if (/\bfunction\b\s+\w+/.test(lower) && !/^\s*end\s+function\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bfunction\b/);
        actions.push({ type: 'open', kind: 'function', opener: 'Function', colOffset: col });
        return;
    }

    // Sub <n>
    if (/\bsub\b\s+\w+/.test(lower) && !/^\s*end\s+sub\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bsub\b/);
        actions.push({ type: 'open', kind: 'sub', opener: 'Sub', colOffset: col });
        return;
    }

    // Property Get / Let / Set
    if (/\bproperty\s+(get|let|set)\b/.test(lower) && !/^\s*end\s+property\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bproperty\b/);
        actions.push({ type: 'open', kind: 'property', opener: 'Property', colOffset: col });
        return;
    }

    // With
    if (/\bwith\b/.test(lower) && !/^\s*end\s+with\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bwith\b/);
        actions.push({ type: 'open', kind: 'with', opener: 'With', colOffset: col });
        return;
    }

    // Class <n>
    if (/\bclass\b\s+\w+/.test(lower) && !/^\s*end\s+class\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bclass\b/);
        actions.push({ type: 'open', kind: 'class', opener: 'Class', colOffset: col });
        return;
    }

    return;
}

// ── If / Select Case branches ─────────────────────────────────────────────────

/** One step of If / Select Case structure: a block opening, a new branch, or its end. */
export interface BranchEvent {
    type:  'open' | 'branch' | 'close';
    block: 'if' | 'select';
}

/**
 * The If / Select Case structure the code of one ASP block carries, in order —
 * which it opens, which it continues with another branch (ElseIf, Else, Case),
 * and which it closes. A single-line `If … Then <statement>` carries none.
 *
 * The HTML structure check reads the tags written in the branches of an If as
 * alternatives, not as one after another, and this is how it finds them.
 */
export function branchEvents(code: string): BranchEvent[] {
    const events: BranchEvent[] = [];

    for (const logical of joinContinuationLines(code.split(/\r?\n/))) {
        for (const segment of removeStrings(logical.text).split(':')) {
            const lower = segment.toLowerCase().replace(/\.\w+/g, ' ').trim();
            if (!lower) { continue; }

            if      (/^end\s+if\b/.test(lower))              { events.push({ type: 'close',  block: 'if' }); }
            else if (/^end\s+select\b/.test(lower))          { events.push({ type: 'close',  block: 'select' }); }
            else if (/^else(if\b|\s|$)/.test(lower))         { events.push({ type: 'branch', block: 'if' }); }
            else if (/^case\b/.test(lower))                  { events.push({ type: 'branch', block: 'select' }); }
            else if (/\bselect\s+case\b/.test(lower))        { events.push({ type: 'open',   block: 'select' }); }
            else if (/\bif\b.*\bthen\b\s+\S/.test(lower))    { /* single-line If */ }
            else if (/\bif\b.*\bthen\b/.test(lower))         { events.push({ type: 'open',   block: 'if' }); }
        }
    }

    return events;
}

// ── Block warnings ────────────────────────────────────────────────────────────
// "Missing End If" and "End If with no If", read from the syntax tree
// (vbscript/pageAnalysis.ts). After an edit they come from the VBScript worker
// thread, with the matching-keyword highlight; Format Document reads them here,
// since it must answer for exactly the text it is about to change.

/** The warnings as diagnostics on `document`, whose text they were read from. */
export function blockDiagnostics(document: vscode.TextDocument, warnings: BlockWarning[]): vscode.Diagnostic[] {
    return warnings.map(w => Object.assign(
        new vscode.Diagnostic(new vscode.Range(document.positionAt(w.start), document.positionAt(w.end)), w.message, vscode.DiagnosticSeverity.Warning),
        { source: 'Classic ASP (VBScript)' },
    ));
}

export function scanAspStructure(document: vscode.TextDocument): vscode.Diagnostic[] {
    return blockDiagnostics(document, pageBlocks(parsePage(document.getText())).warnings);
}

// ── ASP tag balance scanner ───────────────────────────────────────────────────
//
// Checks that every <% has a matching %> and vice versa, across the whole file.
//
// Flagged cases:
//   Stray %>   — no matching <% above it  →  Warning on the %>  (2 chars)
//   Unclosed <% — no matching %> in file  →  Warning on the <%  (2 chars)
export function scanAspTags(document: vscode.TextDocument): vscode.Diagnostic[] {
    const fullText = document.getText();
    const zones    = createZoneResolver(fullText);
    const diagnostics: vscode.Diagnostic[] = [];

    // Find every %> — if getZone at its position is not 'asp', it's a stray closer.
    const closeRegex = /%>/g;
    let m: RegExpExecArray | null;
    while ((m = closeRegex.exec(fullText)) !== null) {
        if (zones.zoneAt(m.index) !== 'asp') {
            const pos = document.positionAt(m.index);
            diagnostics.push(Object.assign(
                new vscode.Diagnostic(
                    new vscode.Range(pos, document.positionAt(m.index + 2)),
                    `Unexpected '%>' — no opening '<%' found`,
                    vscode.DiagnosticSeverity.Warning
                ),
                { source: 'Classic ASP (tags)' }
            ));
        }
    }

    // Find every <% — if getZone just inside the block (offset+2) is not 'asp',
    // the block was never properly closed.
    const openRegex = /<%/g;
    while ((m = openRegex.exec(fullText)) !== null) {
        if (zones.zoneAt(m.index + 2) !== 'asp') {
            const pos = document.positionAt(m.index);
            diagnostics.push(Object.assign(
                new vscode.Diagnostic(
                    new vscode.Range(pos, document.positionAt(m.index + 2)),
                    `Unclosed '<%' — no matching '%>' found`,
                    vscode.DiagnosticSeverity.Warning
                ),
                { source: 'Classic ASP (tags)' }
            ));
        }
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
            ? ` A virtual path starts at the site root, ${virtualRoot} — set "aspLanguageSupport.virtualRoot" if yours is somewhere else.`
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
    return findMissingIncludes(document.getText(), document.uri.fsPath, configuredVirtualRoot())
        .map(found => Object.assign(
            new vscode.Diagnostic(
                new vscode.Range(document.positionAt(found.start), document.positionAt(found.end)),
                found.message,
                vscode.DiagnosticSeverity.Warning,
            ),
            { source: 'Classic ASP (includes)' },
        ));
}

// ── An object assigned without Set ────────────────────────────────────────────

/** The Missing-Set warnings as diagnostics on `document`, whose text they were found in. */
export function missingSetDiagnostics(document: vscode.TextDocument, missingSet: MissingSet[]): vscode.Diagnostic[] {
    return missingSet.map(found => Object.assign(
        new vscode.Diagnostic(
            new vscode.Range(document.positionAt(found.start), document.positionAt(found.end)),
            `Missing Set: an object is assigned here, so this needs \`Set ${found.target} = …\`. ` +
            `Without Set, VBScript tries to copy the object's default value instead, which fails when the page runs.`,
            vscode.DiagnosticSeverity.Warning,
        ),
        { source: 'Classic ASP', code: MISSING_SET_CODE },
    ));
}

const MISSING_SET_CODE = 'missing-set';

/** The quick fix: `Set` in front of the name, or in place of a `Let`. */
class AddSetQuickFix implements vscode.CodeActionProvider {
    static readonly kinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        return context.diagnostics
            .filter(diagnostic => diagnostic.code === MISSING_SET_CODE)
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
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aspLanguageSupport.virtualRoot')) { recheckIncludes(); }
        }),
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