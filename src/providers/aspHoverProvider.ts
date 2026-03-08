import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import { isCursorInHtmlFileLinkAttribute } from '../utils/htmlLinkUtils';
import { COM_MEMBER_DOCS } from '../constants/comObjects';
import { getZone } from '../utils/aspUtils';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// VBScript keyword docs for hover
// ─────────────────────────────────────────────────────────────────────────────
const KEYWORD_DOCS: Record<string, string> = {

    // ── Declarations ──────────────────────────────────────────────────────────
    'dim':     '**Dim** — Declares one or more variables.\n\nExample: `Dim name, age`',
    'redim':   '**ReDim** — Resizes a dynamic array.\n\nExample: `ReDim arr(10)`',
    'set':     '**Set** — Assigns an object reference to a variable.\n\nExample: `Set rs = Server.CreateObject("ADODB.Recordset")`',
    'const':   '**Const** — Declares a constant value that cannot change.\n\nExample: `Const MAX = 100`',

    // ── Conditionals ──────────────────────────────────────────────────────────
    'if':          '**If** — Opens a conditional block.\n\nExample: `If x > 0 Then ... ElseIf ... Else ... End If`',
    'then':        '**Then** — Follows the condition in an `If` or `ElseIf` statement.\n\nExample: `If x > 0 Then`',
    'elseif':      '**ElseIf** — Additional condition branch inside an `If` block.\n\nExample: `ElseIf x = 0 Then`',
    'else':        '**Else** — Fallback branch when no `If` or `ElseIf` condition matched.\n\nExample: `Else\n    x = 0\nEnd If`',
    'end if':      '**End If** — Closes an `If` block.',
    'select case': '**Select Case** — Multi-branch conditional on a single expression.\n\nExample: `Select Case x\n    Case 1 ...\n    Case Else ...\nEnd Select`',
    'end select':  '**End Select** — Closes a `Select Case` block.',
    'case':        '**Case** — A branch inside a `Select Case` block.\n\nExample: `Case 1\n    ...`',
    'case else':   '**Case Else** — The fallback branch inside a `Select Case` block, matching anything not caught by other `Case` values.\n\nExample: `Case Else\n    label = "Unknown"`',

    // ── For loops ─────────────────────────────────────────────────────────────
    'for':      '**For** — Counter-based loop.\n\nExample: `For i = 1 To 10 Step 1 ... Next`',
    'for each': '**For Each** — Iterates over every item in a collection or array.\n\nExample: `For Each item In collection ... Next`',
    'to':       '**To** — Defines the upper bound in a `For` loop.\n\nExample: `For i = 1 To 10`',
    'step':     '**Step** — Defines the increment in a `For` loop.\n\nExample: `For i = 10 To 1 Step -1`',
    'next':     '**Next** — Closes a `For` or `For Each` loop.\n\nExample: `For i = 1 To 10 ... Next`',
    'each':     '**Each** — Used in `For Each` to iterate a collection.\n\nExample: `For Each item In collection`',
    'in':       '**In** — Separates the loop variable from the collection in `For Each`.\n\nExample: `For Each item In collection`',
    'exit for': '**Exit For** — Exits a `For` or `For Each` loop immediately.\n\nExample: `If done Then Exit For`',

    // ── Do / Loop ─────────────────────────────────────────────────────────────
    'do':           '**Do** — Opens a `Do` loop. Can have a pre- or post-condition, or loop forever.\n\nExample: `Do While condition ... Loop`',
    'do while':     '**Do While** — Loops while a condition is true (pre-condition check).\n\nExample: `Do While Not rs.EOF ... Loop`',
    'do until':     '**Do Until** — Loops until a condition becomes true (pre-condition check).\n\nExample: `Do Until cursor = 10 ... Loop`',
    'loop':         '**Loop** — Closes a `Do` block.\n\nExample: `Do ... Loop`',
    'loop while':   '**Loop While** — Closes a `Do` block and repeats while condition is true (post-condition check).\n\nExample: `Do ... Loop While x > 0`',
    'loop until':   '**Loop Until** — Closes a `Do` block and repeats until condition becomes true (post-condition check).\n\nExample: `Do ... Loop Until x >= 5`',
    'exit do':      '**Exit Do** — Exits a `Do` loop immediately.\n\nExample: `If done Then Exit Do`',

    // ── While / Wend ──────────────────────────────────────────────────────────
    'while': '**While** — Condition-based loop. Prefer `Do While` for new code.\n\nExample: `While condition ... Wend`',
    'wend':  '**Wend** — Closes a `While` loop.\n\nExample: `While condition ... Wend`',

    // ── Functions and Subs ────────────────────────────────────────────────────
    'function':     '**Function** — Declares a function that returns a value.\n\nExample: `Function GetName(id) ... End Function`',
    'sub':          '**Sub** — Declares a subroutine that does not return a value.\n\nExample: `Sub ConnectDb() ... End Sub`',
    'end function': '**End Function** — Closes a `Function` block.',
    'end sub':      '**End Sub** — Closes a `Sub` block.',
    'exit function':'**Exit Function** — Exits a `Function` early.\n\nExample: `If b = 0 Then Exit Function`',
    'exit sub':     '**Exit Sub** — Exits a `Sub` early.\n\nExample: `If Not flag Then Exit Sub`',

    // ── With ──────────────────────────────────────────────────────────────────
    'with':      '**With** — Shorthand for repeated access to an object\'s members.\n\nExample: `With rs\n    .MoveNext\nEnd With`',
    'end with':  '**End With** — Closes a `With` block.',

    // ── Class ─────────────────────────────────────────────────────────────────
    'class':     '**Class** — Declares a VBScript class.\n\nExample: `Class MyClass ... End Class`',
    'end class': '**End Class** — Closes a `Class` block.',

    // ── Error handling ────────────────────────────────────────────────────────
    'on error resume next': '**On Error Resume Next** — Suppresses runtime errors and continues execution. Always check `Err.Number` after suspicious calls.\n\nExample: `On Error Resume Next\nconn.Open ...\nIf Err.Number <> 0 Then ...`',
    'on error goto':        '**On Error GoTo 0** — Re-enables normal error handling after `On Error Resume Next`.\n\nExample: `On Error GoTo 0`',
    'goto 0':               '**On Error GoTo 0** — Re-enables normal error handling after `On Error Resume Next`.\n\nExample: `On Error GoTo 0`',
    // Middle/tail words of the 3-word compounds — resolved to the full compound doc
    'error resume':  '**On Error Resume Next** — Suppresses runtime errors and continues execution. Always check `Err.Number` after suspicious calls.',
    'resume next':   '**On Error Resume Next** — Suppresses runtime errors and continues execution. Always check `Err.Number` after suspicious calls.',
    'error goto':    '**On Error GoTo 0** — Re-enables normal error handling after `On Error Resume Next`.',

    // ── Option ────────────────────────────────────────────────────────────────
    'option explicit': '**Option Explicit** — Forces all variables to be declared with `Dim`. Recommended to prevent typo bugs.',
};

// 3-word compound keyword sequences — checked before 2-word compounds.
// Each entry maps the lowercase 3-word key to the KEYWORD_DOCS key to use.
const THREE_WORD_COMPOUNDS: Record<string, string> = {
    'on error resume':   'on error resume next',
    'error resume next': 'on error resume next',
    'on error goto':     'on error goto',
    'error goto 0':      'on error goto',
};


// ─────────────────────────────────────────────────────────────────────────────
// Context detection
// Scans upward from the cursor to determine whether it sits inside a VBScript
// block (<% %>), a JavaScript block (<script>), or plain HTML.
// ─────────────────────────────────────────────────────────────────────────────

type AspContext = 'vbscript' | 'script' | 'html';

function getAspContext(document: vscode.TextDocument, position: vscode.Position): AspContext {
    const fullText   = document.getText();
    const offset     = document.offsetAt(position);
    const textBefore = fullText.slice(0, offset);

    // Check if we're inside a <script> block (language="javascript" or no language attr).
    // Find the last <script and last </script> before the cursor.
    const lastScriptOpen  = textBefore.lastIndexOf('<script');
    const lastScriptClose = textBefore.lastIndexOf('</script');
    if (lastScriptOpen !== -1 && lastScriptOpen > lastScriptClose) {
        // Make sure it's not a VBScript <script language="vbscript"> block
        const scriptTag = fullText.slice(lastScriptOpen, fullText.indexOf('>', lastScriptOpen) + 1);
        if (!/language\s*=\s*["']vbscript["']/i.test(scriptTag)) {
            return 'script';
        }
    }

    // Check if we're inside a <% %> VBScript block.
    // Find the last <% and last %> before the cursor.
    const lastOpen  = textBefore.lastIndexOf('<%');
    const lastClose = textBefore.lastIndexOf('%>');
    if (lastOpen !== -1 && lastOpen > lastClose) {
        return 'vbscript';
    }

    return 'html';
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover provider
// • VBScript context (<% %>): all hovers — keywords, symbols, COM members.
// • Script context (<script>):  symbol/COM hovers only, no keyword docs.
// • HTML context:               no hovers (except HTML link guard already applied).
// ─────────────────────────────────────────────────────────────────────────────
export class AspHoverProvider implements vscode.HoverProvider {

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Hover> {

        const lineText = document.lineAt(position.line).text;

        // Suppress hover inside HTML file-link attributes (href, src, etc.)
        if (isCursorInHtmlFileLinkAttribute(lineText, position.character)) return null;

        const context = getAspContext(document, position);

        // No hovers inside plain HTML
        if (context === 'html') return null;

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const word    = document.getText(wordRange);
        const wordKey = word.toLowerCase();

        const allSymbols = collectAllSymbols(document);
        const docText    = document.getText();

        // ── 1. COM member after dot — e.g. rs.EOF, conn.Execute ──────────────
        const charBeforeWord = lineText.charAt(wordRange.start.character - 1);
        if (charBeforeWord === '.') {
            const textBeforeDot = lineText.substring(0, wordRange.start.character - 1);
            const objMatch      = textBeforeDot.match(/\b(\w+)$/);
            if (objMatch) {
                const objName    = objMatch[1].toLowerCase();
                const comVar     = allSymbols.comVariables.find(cv => cv.name.toLowerCase() === objName);
                if (comVar) {
                    const memberDoc = COM_MEMBER_DOCS[`${comVar.progId}.${wordKey}`];
                    if (memberDoc) {
                        return new vscode.Hover(
                            new vscode.MarkdownString(`**${memberDoc.label}**\n\n${memberDoc.doc}`)
                        );
                    }
                }
            }
        }

        // ── 2. User-defined Function or Sub ───────────────────────────────────
        // Skip functions defined inside a <script> (JS) block in this file —
        // they are JavaScript, not VBScript, and should not show a VBScript hover.
        // Functions from #include files are always VBScript so they are shown as-is.
        const fn = allSymbols.functions.find(f => {
            if (f.name.toLowerCase() !== wordKey) return false;
            if (f.filePath === document.uri.fsPath) {
                const fnOffset = document.offsetAt(new vscode.Position(f.line, 0));
                if (getZone(docText, fnOffset) === 'js') return false;
            }
            return true;
        });
        if (fn) {
            const fromInclude = fn.filePath !== document.uri.fsPath;
            const header      = fn.params
                ? `**${fn.kind} ${fn.name}(${fn.params})**`
                : `**${fn.kind} ${fn.name}**`;
            const source      = fromInclude
                ? `\n\n*Defined in \`${path.basename(fn.filePath)}\`*`
                : `\n\n*Defined in this file*`;
            return new vscode.Hover(new vscode.MarkdownString(header + source));
        }

        // ── 3. COM object variable (rs, conn, dict, etc.) ─────────────────────
        const comVar = allSymbols.comVariables.find(cv => cv.name.toLowerCase() === wordKey);
        if (comVar) {
            const fromInclude = comVar.filePath !== document.uri.fsPath;
            const source      = fromInclude
                ? `*Declared in \`${path.basename(comVar.filePath)}\`*`
                : `*Declared in this file*`;
            return new vscode.Hover(
                new vscode.MarkdownString(
                    `**${comVar.name}** — \`${comVar.progId}\`\n\n${source}\n\nType \`${comVar.name}.\` to see available members.`
                )
            );
        }

        // ── 4. User-defined variable ──────────────────────────────────────────
        const variable = allSymbols.variables.find(v => v.name.toLowerCase() === wordKey);
        if (variable) {
            const fromInclude = variable.filePath !== document.uri.fsPath;
            const source      = fromInclude
                ? `*Declared in \`${path.basename(variable.filePath)}\`*`
                : `*Declared in this file*`;
            return new vscode.Hover(new vscode.MarkdownString(`**${variable.name}** — variable\n\n${source}`));
        }

        // ── 5. User-defined constant ──────────────────────────────────────────
        const constant = allSymbols.constants.find(c => c.name.toLowerCase() === wordKey);
        if (constant) {
            const fromInclude = constant.filePath !== document.uri.fsPath;
            const source      = fromInclude
                ? `*Declared in \`${path.basename(constant.filePath)}\`*`
                : `*Declared in this file*`;
            return new vscode.Hover(
                new vscode.MarkdownString(`**${constant.name}** = \`${constant.value}\`\n\n${source}`)
            );
        }

        // ── 6. VBScript keywords — only inside <% %> blocks ──────────────────
        // Keyword docs are VBScript-specific so we suppress them inside <script>.
        if (context !== 'vbscript') return null;

        // Suppress hover inside comments. Strip string literals first so a quote
        // inside a string isn't mistaken for a comment delimiter.
        const strippedForComment = lineText.replace(/"[^"]*"/g, m => ' '.repeat(m.length));
        const commentIdx         = strippedForComment.indexOf("'");
        if (commentIdx !== -1 && position.character > commentIdx) return null;

        // Extract words immediately before and after the hovered word so we can
        // assemble 2-word and 3-word compound keys and return the correct doc
        // with a range that spans the entire compound, not just the hovered word.

        const textBefore      = lineText.substring(0, wordRange.start.character);
        const textAfter       = lineText.substring(wordRange.end.character);
        const wordBeforeMatch = textBefore.match(/\b(\w+)(\s+)$/);
        const wordAfterMatch  = textAfter.match(/^(\s+)(\w+)\b/);
        const twoBeforeMatch  = wordBeforeMatch
            ? textBefore.substring(0, textBefore.length - wordBeforeMatch[0].length).match(/\b(\w+)(\s+)$/)
            : null;
        const twoAfterMatch   = wordAfterMatch
            ? textAfter.substring(wordAfterMatch[0].length).match(/^(\s+)(\w+)\b/)
            : null;

        const wBefore  = wordBeforeMatch?.[1]?.toLowerCase() ?? '';
        const wAfter   = wordAfterMatch?.[2]?.toLowerCase()  ?? '';
        const wwBefore = twoBeforeMatch?.[1]?.toLowerCase()  ?? '';
        const wwAfter  = twoAfterMatch?.[2]?.toLowerCase()   ?? '';

        // Helper: return a Hover with a range spanning from startCol to endCol
        const makeHover = (doc: string, startCol: number, endCol: number) =>
            new vscode.Hover(
                new vscode.MarkdownString(doc),
                new vscode.Range(
                    new vscode.Position(position.line, startCol),
                    new vscode.Position(position.line, endCol)
                )
            );

        const wStart  = wordRange.start.character;
        const wEnd    = wordRange.end.character;
        const bStart  = wordBeforeMatch  ? wStart  - wordBeforeMatch[0].length  : wStart;
        const bbStart = twoBeforeMatch   ? bStart  - twoBeforeMatch[0].length   : bStart;
        const aEnd    = wordAfterMatch   ? wEnd    + wordAfterMatch[0].length    : wEnd;
        const aaEnd   = twoAfterMatch    ? aEnd    + twoAfterMatch[0].length     : aEnd;

        // ── 3-word compounds ─────────────────────────────────────────────────
        // Check word3 first (cursor on last word), then word2, then word1.
        // This ensures the widest possible range is always returned — e.g.
        // hovering "GoTo" should span "On Error GoTo 0", not just "Error GoTo 0".

        // Helper: if a compound ends with 'goto', extend the range to include
        // a trailing '0' (On Error GoTo 0) since 0 is part of the statement.
        // Also extends 'on error resume' to include trailing 'Next'.
        const extendForGoTo = (docKey: string, endCol: number): number => {
            const tail = lineText.substring(endCol);
            if (docKey.endsWith('goto')) {
                const m = tail.match(/^(\s+)(0)\b/);
                return m ? endCol + m[0].length : endCol;
            }
            if (docKey === 'on error resume next') {
                const m = tail.match(/^(\s+)(next)\b/i);
                return m ? endCol + m[0].length : endCol;
            }
            return endCol;
        };

        // Cursor on word 3: prev 2 + hovered  (e.g. hover "Resume" in "On Error Resume")
        // Also try to look one level further back in case this 3-word compound is itself
        // the tail of a longer known compound (e.g. "error goto 0" inside "on error goto 0").
        if (wwBefore && wBefore) {
            const k = `${wwBefore} ${wBefore} ${wordKey}`;
            const docKey = THREE_WORD_COMPOUNDS[k];
            if (docKey && KEYWORD_DOCS[docKey]) {
                let startCol = bbStart;
                // Look one more word back — if it extends to a known 3-word compound
                // that shares the same docKey, widen to include it too.
                const textBeforeBb = lineText.substring(0, wordRange.start.character
                    - wordBeforeMatch![0].length
                    - twoBeforeMatch![0].length);
                const threeBackMatch = textBeforeBb.match(/\b(\w+)(\s+)$/);
                if (threeBackMatch) {
                    const w3 = threeBackMatch[1].toLowerCase();
                    const wider = THREE_WORD_COMPOUNDS[`${w3} ${wwBefore} ${wBefore}`];
                    if (wider === docKey) startCol = bbStart - threeBackMatch[0].length;
                }
                return makeHover(KEYWORD_DOCS[docKey], startCol, extendForGoTo(docKey, wEnd));
            }
        }
        // Cursor on word 2: prev + hovered + next  (e.g. hover "Error" in "On Error GoTo")
        if (wBefore && wAfter) {
            const k = `${wBefore} ${wordKey} ${wAfter}`;
            const docKey = THREE_WORD_COMPOUNDS[k];
            if (docKey && KEYWORD_DOCS[docKey]) return makeHover(KEYWORD_DOCS[docKey], bStart, extendForGoTo(docKey, aEnd));
        }
        // Cursor on word 1: hovered + next 2  (e.g. hover "On" in "On Error GoTo")
        if (wAfter && wwAfter) {
            const k = `${wordKey} ${wAfter} ${wwAfter}`;
            const docKey = THREE_WORD_COMPOUNDS[k];
            if (docKey && KEYWORD_DOCS[docKey]) return makeHover(KEYWORD_DOCS[docKey], wStart, extendForGoTo(docKey, aaEnd));
        }

        // ── 2-word compounds ─────────────────────────────────────────────────
        // Case a: word before + hovered  (e.g. "End Function", "Do While", "GoTo 0")
        // Walk back up to two extra levels to widen to the full compound range.
        if (wBefore) {
            const k = `${wBefore} ${wordKey}`;
            if (KEYWORD_DOCS[k]) {
                let startCol = bStart;
                // One level back: e.g. "error goto 0" → startCol = bbStart (Error)
                if (wwBefore) {
                    const wider1 = THREE_WORD_COMPOUNDS[`${wwBefore} ${wBefore} ${wordKey}`];
                    if (wider1) {
                        startCol = bbStart;
                        // Two levels back: look for a word before wwBefore that forms a 3-word
                        // compound with wwBefore+wBefore — e.g. "on" before "error goto 0"
                        const textBeforeBb = lineText.substring(0, wordRange.start.character - wordBeforeMatch![0].length - twoBeforeMatch![0].length);
                        const threeBeforeMatch = textBeforeBb.match(/\b(\w+)(\s+)$/);
                        if (threeBeforeMatch) {
                            const ww3 = threeBeforeMatch[1].toLowerCase();
                            const wider2 = THREE_WORD_COMPOUNDS[`${ww3} ${wwBefore} ${wBefore}`];
                            if (wider2 === wider1) startCol = bbStart - threeBeforeMatch[0].length;
                        }
                    }
                }
                return makeHover(KEYWORD_DOCS[k], startCol, wEnd);
            }
        }
        // Case b: hovered + word after  (e.g. "For Each", "Loop Until")
        // Special case: GoTo + 0 — extend range to include the 0
        if (wAfter) {
            const k = `${wordKey} ${wAfter}`;
            if (KEYWORD_DOCS[k]) {
                const endCol = extendForGoTo(k, aEnd);
                return makeHover(KEYWORD_DOCS[k], wStart, endCol);
            }
        }

        // ── Single keyword ────────────────────────────────────────────────────
        if (KEYWORD_DOCS[wordKey]) {
            return new vscode.Hover(new vscode.MarkdownString(KEYWORD_DOCS[wordKey]));
        }

        return null;
    }
}