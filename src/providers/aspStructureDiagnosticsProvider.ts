/**
 * aspStructureDiagnosticsProvider.ts
 *
 * Detects mismatched VBScript block keywords inside <% ... %> blocks in .asp
 * files and reports them as Warning diagnostics (orange squiggles).
 *
 * Pairs checked:
 *   If          → End If
 *   For / For Each → Next
 *   While       → Wend
 *   Do          → Loop
 *   With        → End With
 *   Function    → End Function
 *   Sub         → End Sub
 *   Select Case → End Select
 *   Class       → End Class
 *
 * Skips:
 *  - VBScript comment lines (first non-whitespace char is ')
 *  - REM comment lines
 *  - Content of string literals
 *  - Single-line If ... Then <statement>  (no End If needed)
 *  - On Error Resume Next  (contains "Next" but is not a For/Next closer)
 *  - Loop While / Loop Until  (contains "Loop" — is a Do/Loop closer, handled)
 *  - Line-continuation (_) — physical lines joined into logical lines before
 *    classification so that multi-line If...Then constructs are handled correctly
 *
 * Debounced at 1500 ms so it doesn't fire on every keystroke.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { createZoneResolver } from '../utils/zoneUtils';
import { parseIncludeDirectives, resolveIncludeDirective } from '../utils/includeDirectives';
import { callIsWholeExpression } from '../utils/symbolParser';
import { isRemAt, vbStatementsOnLine } from '../utils/documentHelper';
import { COM_METHOD_RETURN_TYPES } from '../constants/comObjects';
import { areIncludeSymbolsReady, collectAllSymbols, configuredVirtualRoot, preloadIncludeSymbols } from './includeProvider';

// ── Block descriptor ──────────────────────────────────────────────────────────

interface BlockEntry {
    kind:    BlockKind;   // canonical name for matching
    opener:  string;      // display text for error messages  e.g. "If"
    closer:  string;      // expected closer text            e.g. "End If"
    line:    number;      // physical line number (start of the logical line)
    col:     number;
}

type BlockKind =
    | 'if' | 'for' | 'while' | 'do' | 'with'
    | 'function' | 'sub' | 'select' | 'class' | 'property';

// ── Strip string literals from a line ─────────────────────────────────────────

function removeStrings(line: string): string {
    let result = '';
    let inStr  = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') {
            if (inStr && i + 1 < line.length && line[i + 1] === '"') { i++; continue; }
            inStr = !inStr;
        } else if (!inStr) {
            // A VBScript comment ( ' or legacy REM ) runs to end-of-line, so its
            // text must never be classified — otherwise `REM If x Then` or
            // `x = 1 : REM For each` fakes a block opener ("Missing End If" etc.).
            if (line[i] === "'" || isRemAt(line, i)) { break; }
            result += line[i];
        }
    }
    return result;
}

// ── Extract only real ASP *code* from a physical line ─────────────────────────
//
// The structure scanner must classify VBScript, never the HTML around it. A line
// like  <td>Total <%= x %> items with tax</td>  is mostly HTML; only the text
// inside <% ... %> is VBScript. The old approach stripped just the <% / %>
// delimiters and kept everything else, so prose words like "with" / "do" /
// "class" were misread as block openers (phantom "Missing End With" etc.).
//
// Rules:
//  • No <% on the line → the whole line is code (we are inside a multi-line
//    <% %> block or a server-side VBScript <script> body — there is no HTML to
//    strip, and the leading/continuation code must still be classified).
//  • Otherwise → concatenate ONLY the code inside <% ... %> statement blocks,
//    joined by " : " so classifyLine (which splits on colons) classifies each.
//    <%= ... %> output expressions carry no block structure and are ignored.
export function extractAspStatementCode(lineText: string): string {
    if (lineText.indexOf('<%') === -1) { return lineText; }

    const codes: string[] = [];
    let i = 0;
    while (i < lineText.length) {
        const open = lineText.indexOf('<%', i);
        if (open === -1) { break; }
        const close = lineText.indexOf('%>', open + 2);
        const end   = close === -1 ? lineText.length : close;
        // Ignore <%= ... %> (and <% = ... %>) output expressions — they are
        // Response.Write shorthand and never carry block structure.
        if (!lineText.slice(open + 2, end).trimStart().startsWith('=')) {
            codes.push(lineText.slice(open + 2, end));
        }
        i = close === -1 ? lineText.length : close + 2;
    }
    return codes.join(' : ');
}

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

// ── Matched block pairs ────────────────────────────────────────────────────────
// A successfully matched opener/closer (the "good" case the diagnostics above
// never report). Used to highlight the keyword matching the one under the
// caret, which needs exactly the pairing scanAspStructure already computes
// internally, just without throwing the matches away.

export interface BlockPair {
    opener: { range: vscode.Range; text: string };
    closer: { range: vscode.Range; text: string };
}

// ── Main scanner ──────────────────────────────────────────────────────────────
// Shared by scanAspStructure (diagnostics for what's WRONG) and
// getMatchedBlockPairs (ranges for what's RIGHT) so the two can never disagree
// about how a file's blocks nest.

type BlockScan = { diagnostics: vscode.Diagnostic[]; pairs: BlockPair[] };

// The squiggles and the matching-keyword highlight both ask after every edit,
// about the same text, and each used to scan the whole document for it. The
// last scan of each of the most recent documents is kept for the other to use.
const MAX_REMEMBERED_SCANS = 8;
const _lastScan = new Map<string, { text: string; scan: BlockScan }>();

function scanBlocks(document: vscode.TextDocument): BlockScan {
    const fullText = document.getText();
    const key      = document.uri?.toString() ?? '';

    const last = _lastScan.get(key);
    if (last?.text === fullText) { return last.scan; }

    const scan = scanBlocksIn(document, fullText);
    _lastScan.delete(key);
    _lastScan.set(key, { text: fullText, scan });
    if (_lastScan.size > MAX_REMEMBERED_SCANS) { _lastScan.delete(_lastScan.keys().next().value!); }
    return scan;
}

function scanBlocksIn(document: vscode.TextDocument, fullText: string): BlockScan {
    // One linear scan, then binary-search lookups. Asking getZone per line
    // rescanned the whole document each time: on a 12,000-line page this
    // function alone took ~36s, and it runs behind both the block diagnostics
    // and the matching-keyword highlight.
    const zones    = createZoneResolver(fullText);
    const lineCount = document.lineCount;
    const diagnostics: vscode.Diagnostic[] = [];
    const pairs: BlockPair[] = [];
    const stack: BlockEntry[] = [];

    // Collect raw physical line strings
    const physicalLines: string[] = [];
    for (let li = 0; li < lineCount; li++) {
        physicalLines.push(document.lineAt(li).text);
    }

    // Join continuation lines into logical lines before classification.
    // Each logical line records the physical line it started on.
    const logicalLines = joinContinuationLines(physicalLines);

    for (const logical of logicalLines) {
        const li       = logical.physicalLine;
        const lineText = logical.text;
        const lineOffset = document.offsetAt(new vscode.Position(li, 0));

        // Find a reliable offset inside the ASP block by locating <% on this line,
        // or falling back to the line midpoint for <script language="vbscript"> content.
        const rawLine  = physicalLines[li];
        const aspOpenIdx = rawLine.indexOf('<%');
        const probeCol   = aspOpenIdx !== -1 ? aspOpenIdx + 2 : Math.floor(rawLine.length / 2);
        const midOffset  = lineOffset + probeCol;
        // Accept lines that are either inside a <% %> block OR inside a VBScript <script> block.
        if (zones.zoneAt(midOffset) !== 'asp') { continue; }

        const trimmed = lineText.trimStart();

        // Skip VBScript comment lines and REM lines
        if (trimmed.startsWith("'") || /^rem\s/i.test(trimmed)) { continue; }

        // Classify ONLY the VBScript inside <% ... %> on this line — never the
        // surrounding HTML. Compact forms like <%End If%>, <%If x Then%>, <%Else%>
        // still work because their code is extracted; inline output expressions
        // (<%= x %>) and HTML prose are excluded so they can't fake a block opener.
        const classifyText = extractAspStatementCode(lineText).trim();

        const actions = classifyLine(classifyText);

        for (const action of actions) {
            if (action.type === 'open') {
                stack.push({
                    kind:   action.kind,
                    opener: action.opener,
                    closer: closerFor(action.kind),
                    line:   li,
                    col: (() => {
                        const keyword = lineText.toLowerCase().indexOf(action.opener.toLowerCase(), lineText.indexOf('<%'));
                        return keyword !== -1 ? keyword : action.colOffset;
                    })(),
                });
            } else {
                // Closer — find nearest matching opener on the stack
                let matched = -1;
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === action.kind) { matched = s; break; }
                }

                if (matched === -1) {
                    // Stray closer — no matching opener
                    const col   = physicalLines[li].toLowerCase().indexOf(action.closer.toLowerCase());
                    const start = new vscode.Position(li, Math.max(0, col));
                    const end   = new vscode.Position(li, Math.max(0, col) + action.closer.length);
                    diagnostics.push(Object.assign(
                        new vscode.Diagnostic(
                            new vscode.Range(start, end),
                            `Unexpected closing keyword — no matching opener found for '${action.closer}'`,
                            vscode.DiagnosticSeverity.Warning
                        ),
                        { source: 'Classic ASP (VBScript)' }
                    ));
                } else {
                    // Pop everything above the match — those are unclosed openers
                    for (let s = stack.length - 1; s > matched; s--) {
                        const unclosed = stack[s];
                        const start    = new vscode.Position(unclosed.line, unclosed.col);
                        const end      = new vscode.Position(unclosed.line, unclosed.col + unclosed.opener.length);
                        diagnostics.push(Object.assign(
                            new vscode.Diagnostic(
                                new vscode.Range(start, end),
                                `Missing closing keyword — no '${unclosed.closer}' found for this '${unclosed.opener}'`,
                                vscode.DiagnosticSeverity.Warning
                            ),
                            { source: 'Classic ASP (VBScript)' }
                        ));
                    }

                    // The entry at `matched` genuinely closed — record the pair.
                    // Same column-finding approach as the stray-closer case above:
                    // search the closer's own physical line for its keyword text.
                    const entry     = stack[matched];
                    const closerCol = Math.max(0, physicalLines[li].toLowerCase().indexOf(action.closer.toLowerCase()));
                    pairs.push({
                        opener: {
                            range: new vscode.Range(
                                new vscode.Position(entry.line, entry.col),
                                new vscode.Position(entry.line, entry.col + entry.opener.length),
                            ),
                            text: entry.opener,
                        },
                        closer: {
                            range: new vscode.Range(
                                new vscode.Position(li, closerCol),
                                new vscode.Position(li, closerCol + action.closer.length),
                            ),
                            text: action.closer,
                        },
                    });

                    stack.splice(matched); // remove match + everything above
                }
            }
        }
    }

    // Anything left on the stack is unclosed
    for (const entry of stack) {
        const start = new vscode.Position(entry.line, entry.col);
        const end   = new vscode.Position(entry.line, entry.col + entry.opener.length);
        diagnostics.push(Object.assign(
            new vscode.Diagnostic(
                new vscode.Range(start, end),
                `Missing closing keyword — no '${entry.closer}' found for this '${entry.opener}'`,
                vscode.DiagnosticSeverity.Warning
            ),
            { source: 'Classic ASP (VBScript)' }
        ));
    }

    return { diagnostics, pairs };
}

export function scanAspStructure(document: vscode.TextDocument): vscode.Diagnostic[] {
    return scanBlocks(document).diagnostics;
}

/** Every successfully matched opener/closer pair in the document, in the order their closers were found. */
export function getMatchedBlockPairs(document: vscode.TextDocument): BlockPair[] {
    return scanBlocks(document).pairs;
}

function closerFor(kind: BlockKind): string {
    switch (kind) {
        case 'if':       return 'End If';
        case 'for':      return 'Next';
        case 'while':    return 'Wend';
        case 'do':       return 'Loop';
        case 'with':     return 'End With';
        case 'function': return 'End Function';
        case 'sub':      return 'End Sub';
        case 'select':   return 'End Select';
        case 'class':    return 'End Class';
        case 'property': return 'End Property';
    }
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

/**
 * What a method returns, when that result has no value of its own to copy: a
 * Recordset's default is its Fields collection, which needs an index; a
 * TextStream or an XML node has no default at all. Assigning one without Set
 * fails when the page runs. A File or Folder is left out on purpose — its
 * default is its Path, so `p = fso.GetFolder(".")` is a working way to get one.
 */
const OBJECT_ONLY_RESULTS = new Set([
    'adodb.recordset', 'scripting.textstream', 'msxml2.ixmldomnode', 'msxml2.ixmldomnodelist',
]);

/** An assignment that needs Set: the offsets of the name it assigns to. */
export interface MissingSet {
    start:  number;
    end:    number;
    target: string;
}

/**
 * Every `x = …` whose right-hand side is certainly an object, which VBScript
 * only assigns with `Set x = …`: `CreateObject(…)`, `Server.CreateObject(…)`,
 * `GetObject(…)`, `New SomeClass`, and a method on a variable of known type
 * that returns one of OBJECT_ONLY_RESULTS — `rs = conn.Execute(sql)`.
 *
 * The call must be the whole right-hand side: `n = conn.Execute(sql)(0)` reads
 * a value out of the Recordset, and is right as it is. `comTypes` maps a
 * variable name, lower-cased, to the ProgID it was created as.
 */
export function findMissingSet(text: string, comTypes: Map<string, string>): MissingSet[] {
    const zones = createZoneResolver(text);
    const found: MissingSet[] = [];

    let lineStart = 0;
    for (const line of text.split('\n')) {
        const startsInAsp = zones.zoneAt(lineStart) === 'asp' && !line.trimStart().startsWith('<%');
        if (startsInAsp || line.includes('<%')) {
            for (const statement of vbStatementsOnLine(line, startsInAsp)) {
                const assignment = /^(\s*(?:Let\s+)?)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*=\s*(\S.*?)\s*$/i.exec(statement.text);
                if (!assignment) { continue; }

                const [, lead, target, value] = assignment;
                if (!isObjectValue(value, comTypes)) { continue; }

                const start = lineStart + statement.col + lead.length;
                found.push({ start, end: start + target.length, target });
            }
        }
        lineStart += line.length + 1;
    }
    return found;
}

function isObjectValue(value: string, comTypes: Map<string, string>): boolean {
    if (/^New\s+[A-Za-z_]\w*$/i.test(value)) { return true; }

    const creation = /^(?:Server\s*\.\s*)?(?:CreateObject|GetObject)\s*\(/i.exec(value);
    if (creation) { return callIsWholeExpression(value, creation[0].length - 1); }

    const call = /^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*(\(|$)/.exec(value);
    if (!call) { return false; }
    const progId = comTypes.get(call[1].toLowerCase());
    const result = progId && COM_METHOD_RETURN_TYPES[`${progId}.${call[2].toLowerCase()}`];
    if (!result || !OBJECT_ONLY_RESULTS.has(result)) { return false; }
    return call[3] === '' || callIsWholeExpression(value, call[0].length - 1);
}

/** Missing-Set warnings for a page, using the object types known from it and its includes. */
export function scanMissingSet(document: vscode.TextDocument): vscode.Diagnostic[] {
    const comTypes = new Map<string, string>();
    for (const variable of collectAllSymbols(document).comVariables) {
        if (!comTypes.has(variable.name.toLowerCase())) { comTypes.set(variable.name.toLowerCase(), variable.progId); }
    }

    return findMissingSet(document.getText(), comTypes).map(found => Object.assign(
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
    // Its own collection: a missing include or a missing Set is worth knowing
    // about, but neither is a structure problem, so neither may stop Format
    // Document — which refuses to run while `collection` has anything in it.
    const checksCollection = vscode.languages.createDiagnosticCollection('classic-asp-checks');
    context.subscriptions.push(
        collection,
        checksCollection,
        vscode.languages.registerCodeActionsProvider(
            { language: 'asp' }, new AddSetQuickFix(), { providedCodeActionKinds: AddSetQuickFix.kinds },
        ),
    );

    function scanChecks(document: vscode.TextDocument): void {
        checksCollection.set(document.uri, [...scanIncludes(document), ...scanMissingSet(document)]);
    }

    // Per-document debounce timers, keyed by URI, so editing one open .asp file
    // never cancels another file's pending scan (a single shared timer did).
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function scanNow(document: vscode.TextDocument): void {
        collection.set(document.uri, [
            ...scanAspTags(document),
            ...scanAspStructure(document),
        ]);
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