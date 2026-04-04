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
import { isInsideAspBlock } from '../utils/aspUtils';

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
            if (line[i] === "'") break; // VBScript comment
            result += line[i];
        }
    }
    return result;
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
                    // Blank line with no open chain — emit as-is and advance
                    result.push({ text: '', physicalLine: i });
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

function classifyLine(raw: string): LineAction[] {
    const stripped = removeStrings(raw);
    const lower    = stripped.toLowerCase().trim();
    const actions: LineAction[] = [];

    if (!lower) return actions;

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
        return actions; // End X never also opens something
    }

    // Next — closes For / For Each
    // Guard: "On Error Resume Next" must NOT be treated as a For closer
    if (/^next(\s|$)/.test(lower) && !/resume\s+next/.test(lower)) {
        actions.push({ type: 'close', kind: 'for', closer: 'Next', colOffset: 0 });
        return actions;
    }

    // Wend — closes While
    if (/^wend(\s|$)/.test(lower)) {
        actions.push({ type: 'close', kind: 'while', closer: 'Wend', colOffset: 0 });
        return actions;
    }

    // Loop / Loop While / Loop Until — closes Do
    if (/^loop(\s|$)/.test(lower)) {
        actions.push({ type: 'close', kind: 'do', closer: 'Loop', colOffset: 0 });
        return actions;
    }

    // ElseIf / Else — neither opens nor closes If (they're mid-block)
    if (/^else(if\b|\s|$)/.test(lower)) {
        return actions;
    }

    // ── Openers ───────────────────────────────────────────────────────────────

    // If ... Then <statement on same line> — single-line If, no End If needed
    // Detected by: has "then" followed by non-whitespace content
    if (/\bif\b.*\bthen\b\s+\S/.test(lower)) {
        return actions; // single-line If
    }

    // If ... Then (block) — now correctly matches even when If and Then were on
    // separate physical lines and have been joined by joinContinuationLines
    if (/\bif\b.*\bthen\b/.test(lower)) {
        const col = raw.toLowerCase().indexOf('if');
        actions.push({ type: 'open', kind: 'if', opener: 'If', colOffset: col });
        return actions;
    }

    // Select Case
    if (/\bselect\s+case\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bselect\b/);
        actions.push({ type: 'open', kind: 'select', opener: 'Select Case', colOffset: col });
        return actions;
    }

    // For Each / For <var> = ...
    if (/\bfor\s+each\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bfor\b/);
        actions.push({ type: 'open', kind: 'for', opener: 'For Each', colOffset: col });
        return actions;
    }
    if (/\bfor\s+\w+\s*=/.test(lower)) {
        const col = raw.toLowerCase().search(/\bfor\b/);
        actions.push({ type: 'open', kind: 'for', opener: 'For', colOffset: col });
        return actions;
    }

    // Do / Do While / Do Until — must come BEFORE the While check.
    // Guard: "Exit Do" contains the word "do" but is NOT a block opener.
    if (/\bdo\s+while\b/.test(lower) && !/\bexit\s+do\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bdo\b/);
        actions.push({ type: 'open', kind: 'do', opener: 'Do While', colOffset: col });
        return actions;
    }
    if (/\bdo\s+until\b/.test(lower) && !/\bexit\s+do\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bdo\b/);
        actions.push({ type: 'open', kind: 'do', opener: 'Do Until', colOffset: col });
        return actions;
    }
    // Bare "Do" — but NOT "Exit Do"
    if (/\bdo\b(\s|$)/.test(lower) && !/\bexit\s+do\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bdo\b/);
        actions.push({ type: 'open', kind: 'do', opener: 'Do', colOffset: col });
        return actions;
    }

    // While ... Wend
    // Guard: "Exit While" contains the word "while" but is NOT a block opener.
    if (/\bwhile\b/.test(lower) && !/^loop\b/.test(lower) && !/^do\b/.test(lower) && !/\bexit\s+while\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bwhile\b/);
        actions.push({ type: 'open', kind: 'while', opener: 'While', colOffset: col });
        return actions;
    }

    // Function <n>
    if (/\bfunction\b\s+\w+/.test(lower) && !/^\s*end\s+function\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bfunction\b/);
        actions.push({ type: 'open', kind: 'function', opener: 'Function', colOffset: col });
        return actions;
    }

    // Sub <n>
    if (/\bsub\b\s+\w+/.test(lower) && !/^\s*end\s+sub\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bsub\b/);
        actions.push({ type: 'open', kind: 'sub', opener: 'Sub', colOffset: col });
        return actions;
    }

    // Property Get / Let / Set
    if (/\bproperty\s+(get|let|set)\b/.test(lower) && !/^\s*end\s+property\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bproperty\b/);
        actions.push({ type: 'open', kind: 'property', opener: 'Property', colOffset: col });
        return actions;
    }

    // With
    if (/\bwith\b/.test(lower) && !/^\s*end\s+with\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bwith\b/);
        actions.push({ type: 'open', kind: 'with', opener: 'With', colOffset: col });
        return actions;
    }

    // Class <n>
    if (/\bclass\b\s+\w+/.test(lower) && !/^\s*end\s+class\b/.test(lower)) {
        const col = raw.toLowerCase().search(/\bclass\b/);
        actions.push({ type: 'open', kind: 'class', opener: 'Class', colOffset: col });
        return actions;
    }

    return actions;
}

// ── Main scanner ──────────────────────────────────────────────────────────────

function scanAspStructure(document: vscode.TextDocument): vscode.Diagnostic[] {
    const text        = document.getText();
    const lineCount   = document.lineCount;
    const diagnostics: vscode.Diagnostic[] = [];
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

        // Find a reliable offset inside the ASP block by locating <% on this line
        const rawLine  = physicalLines[li];
        const aspOpenIdx = rawLine.indexOf('<%');
        const probeCol   = aspOpenIdx !== -1 ? aspOpenIdx + 2 : Math.floor(rawLine.length / 2);
        const midOffset  = lineOffset + probeCol;
        if (!isInsideAspBlock(text, midOffset)) { continue; }

        const trimmed = lineText.trimStart();

        // Skip VBScript comment lines and REM lines
        if (trimmed.startsWith("'") || /^rem\s/i.test(trimmed)) { continue; }

        // Strip inline ASP delimiters so that compact forms like <%End If%>,
        // <%If x Then%>, <%Else%> are classified correctly.
        // classifyLine anchors some patterns at ^ (e.g. /^end\s+if/) so the
        // leading <% must be removed before classification.
        const classifyText = lineText.replace(/^\s*<%=?\s*/i, '').replace(/\s*%>\s*$/i, '');

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

    return diagnostics;
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
// Rules that match real ASP/VBScript behaviour (and isInsideAspBlock):
//   • Inside an HTML comment <!-- ... -->  →  <% is not a real open tag
//   • Inside a string literal "..."        →  %> is not a real close tag
//   • After a VBScript comment marker '   →  %> to end-of-line is not a real
//                                             close tag (same as isInsideAspBlock)
//   • <% inside an already-open ASP block →  ignored (VBScript is not nestable)
//
// Flagged cases:
//   Stray %>   — no matching <% above it  →  Warning on the %>  (2 chars)
//   Unclosed <% — no matching %> in file  →  Warning on the <%  (2 chars)

function scanAspTags(document: vscode.TextDocument): vscode.Diagnostic[] {
    const text        = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // Stack of unclosed <% positions (absolute text offsets)
    const openStack: number[] = [];

    let i      = 0;
    let inAsp  = false;
    let inHtml = false;   // inside <!-- ... -->

    while (i < text.length) {

        // ── Outside ASP ───────────────────────────────────────────────────────
        if (!inAsp) {

            // Enter / skip HTML comment
            if (!inHtml && text.slice(i, i + 4) === '<!--') {
                inHtml = true;
                i += 4;
                continue;
            }
            if (inHtml) {
                if (text.slice(i, i + 3) === '-->') { inHtml = false; i += 3; }
                else { i++; }
                continue;
            }

            // <% opens an ASP block (<%=  and  <%-- both included — the char
            // after <% is just the first content character)
            if (text[i] === '<' && text[i + 1] === '%') {
                openStack.push(i);
                inAsp = true;
                i += 2;
                continue;
            }

            // Stray %> — no open <% above
            if (text[i] === '%' && text[i + 1] === '>') {
                const pos   = document.positionAt(i);
                const range = new vscode.Range(pos, document.positionAt(i + 2));
                diagnostics.push(Object.assign(
                    new vscode.Diagnostic(
                        range,
                        `Unexpected '%>' — no opening '<%' found`,
                        vscode.DiagnosticSeverity.Warning
                    ),
                    { source: 'Classic ASP (tags)' }
                ));
                i += 2;
                continue;
            }

            i++;
            continue;
        }

        // ── Inside ASP — scan line by line so ' comments are handled correctly ─
        const lineEnd = text.indexOf('\n', i);
        const end     = lineEnd === -1 ? text.length : lineEnd + 1;

        let j     = i;
        let inStr = false;
        let closedThisLine = false;

        while (j < end) {
            const ch = text[j];

            // String literal — %> inside is not a close tag
            if (inStr) {
                if (ch === '"') {
                    if (j + 1 < end && text[j + 1] === '"') { j += 2; continue; } // escaped ""
                    inStr = false;
                }
                j++;
                continue;
            }
            if (ch === '"') { inStr = true; j++; continue; }

            // VBScript inline comment — rest of line is comment text, but %>
            // still closes the ASP block. Keep scanning for %> only.
            // Any <% found here is just comment text — not a real nested open.
            if (ch === "'") {
                while (j < end) {
                    if (text[j] === '%' && j + 1 < text.length && text[j + 1] === '>') {
                        openStack.pop(); // matched — close the <%
                        inAsp = false;
                        i     = j + 2;
                        closedThisLine = true;
                        break;
                    }
                    j++;
                }
                // Whether or not we found %>, done with this line
                if (!closedThisLine) {
                    i = end;
                    closedThisLine = true; // prevent the !closedThisLine path below
                }
                break;
            }

            // %> closes the block
            if (ch === '%' && j + 1 < text.length && text[j + 1] === '>') {
                openStack.pop(); // matched — remove the corresponding <%
                inAsp = false;
                i     = j + 2;
                closedThisLine = true;
                break;
            }

            j++;
        }

        if (!closedThisLine) {
            i = end; // advance to next line, stay inAsp
        }
    }

    // Anything left on the open stack is an unclosed <%
    for (const openOffset of openStack) {
        const pos   = document.positionAt(openOffset);
        const range = new vscode.Range(pos, document.positionAt(openOffset + 2));
        diagnostics.push(Object.assign(
            new vscode.Diagnostic(
                range,
                `Unclosed '<%' — no matching '%>' found`,
                vscode.DiagnosticSeverity.Warning
            ),
            { source: 'Classic ASP (tags)' }
        ));
    }

    return diagnostics;
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerAspStructureDiagnostics(
    context: vscode.ExtensionContext
): vscode.DiagnosticCollection {

    const collection = vscode.languages.createDiagnosticCollection('classic-asp-vbscript-structure');
    context.subscriptions.push(collection);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    function schedule(document: vscode.TextDocument): void {
        if (document.languageId !== 'asp') { return; }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            collection.set(document.uri, [
                ...scanAspTags(document),
                ...scanAspStructure(document),
            ]);
        }, 1500);
    }

    // Run immediately on already-open documents
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'asp') {
            collection.set(doc.uri, [
                ...scanAspTags(doc),
                ...scanAspStructure(doc),
            ]);
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(schedule),
        vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
    );

    return collection;
}