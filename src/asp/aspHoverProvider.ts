import * as vscode from 'vscode';
import { withIncludeSymbols } from './includeProvider';
import { isCursorInHtmlFileLinkAttribute } from '../html/htmlLinkUtils';
import { COM_MEMBER_DOCS } from '../constants/comObjects';
import {
    ASP_MEMBER_DOCS, ASP_OBJECTS, ASP_OBJECT_NAMES, AspObjectDef, BUILTIN_FUNCTION_DOCS, VBSCRIPT_CONSTANTS, VBSCRIPT_KEYWORDS_SET,
} from '../constants/aspKeywords';
import * as path from 'path';
import { declarationsOf, resolveAt, type BoundPage, type Target } from '../vbscript/references';
import type { Declaration } from '../vbscript/binder';
import { PROCEDURE_WORD, sourceOf, walkStatements, type ParsedPage } from '../vbscript/symbols';
import { analysedPage, editorWorkspace } from './vbscriptWorkspace';
import { pathKey, samePath } from '../core/paths';
import { contextAt, textOf } from '../platform/documentState';
import { enclosingWithObject } from './aspCompletionProvider';

// ─────────────────────────────────────────────────────────────────────────────
// VBScript keyword docs for hover
// ─────────────────────────────────────────────────────────────────────────────
export const KEYWORD_DOCS: Record<string, string> = {

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

    'on error goto 0':      '**On Error GoTo 0** — Re-enables normal error handling after `On Error Resume Next`.\n\nExample: `On Error GoTo 0`',

    // ── Option ────────────────────────────────────────────────────────────────
    'option explicit': '**Option Explicit** — Forces all variables to be declared with `Dim`. Recommended to prevent typo bugs.',

    // ── Arrays ────────────────────────────────────────────────────────────────
    'preserve': '**Preserve** — With `ReDim`, keeps the values already in the array. Only the last dimension can change size.\n\nExample: `ReDim Preserve arr(UBound(arr) + 1)`',
    'erase':    '**Erase** — Clears an array: a fixed-size array\'s elements are reset, a dynamic array\'s storage is freed.\n\nExample: `Erase arr`',

    // ── Loops and leaving blocks ──────────────────────────────────────────────
    'until':         '**Until** — Repeats a `Do` loop until the condition becomes true.\n\nExample: `Do Until rs.EOF ... Loop`',
    'exit':          '**Exit** — Leaves a block early: `Exit Do`, `Exit For`, `Exit Function`, `Exit Property` or `Exit Sub`.',
    'exit property': '**Exit Property** — Exits a `Property` procedure early.\n\nExample: `If IsEmpty(m_name) Then Exit Property`',

    // ── Procedures and arguments ──────────────────────────────────────────────
    'byref': '**ByRef** — The argument is passed by reference: a change the procedure makes to it is seen by the caller. This is the default.\n\nExample: `Sub Clear(ByRef list)`',
    'byval': '**ByVal** — The argument is passed by value: the procedure works on a copy, and the caller\'s variable is unchanged.\n\nExample: `Function Twice(ByVal n)`',
    'call':  '**Call** — Calls a Sub or Function, with its arguments in parentheses. A Function\'s return value is discarded.\n\nExample: `Call LogLine("saved")`',

    // ── Classes ───────────────────────────────────────────────────────────────
    'property':         '**Property** — Declares a property of a class: `Property Get` reads it, `Property Let` assigns a value, `Property Set` assigns an object.\n\nExample: `Public Property Get Name ... End Property`',
    'property get':     '**Property Get** — The code that runs when a class\'s property is read; it returns the value.\n\nExample: `Public Property Get Name\n    Name = m_name\nEnd Property`',
    'property let':     '**Property Let** — The code that runs when a value is assigned to a class\'s property.\n\nExample: `Public Property Let Name(value)\n    m_name = value\nEnd Property`',
    'property set':     '**Property Set** — The code that runs when an object is assigned to a class\'s property with `Set`.\n\nExample: `Public Property Set Conn(value)\n    Set m_conn = value\nEnd Property`',
    'end property':     '**End Property** — Closes a `Property` block.',
    'get':              '**Get** — In `Property Get`: the procedure that returns a property\'s value.',
    'let':              '**Let** — In `Property Let`: the procedure that assigns a property\'s value. On its own it may start an assignment, which needs no keyword.\n\nExample: `Let x = 1` is the same as `x = 1`',
    'new':              '**New** — Creates an instance of a VBScript class. A COM object is created with `Server.CreateObject` instead.\n\nExample: `Set cart = New ShoppingCart`',
    'me':               '**Me** — Inside a class, the instance whose code is running.\n\nExample: `Me.Total = 0`',
    'default':          '**Default** — Marks the one member used when the object is written without a member name.\n\nExample: `Public Default Function Item(key)`',
    'class_initialize': '**Class_Initialize** — The Sub a class runs when `New` creates an instance.\n\nExample: `Private Sub Class_Initialize()\n    m_count = 0\nEnd Sub`',
    'class_terminate':  '**Class_Terminate** — The Sub a class runs when its instance is released, e.g. by `Set obj = Nothing`.\n\nExample: `Private Sub Class_Terminate()\n    m_conn.Close\nEnd Sub`',
    'private':          '**Private** — Visible only inside its own class, or its own script page at the top level.\n\nExample: `Private m_name`',
    'public':           '**Public** — Visible to all code; in a class, a member callers can use. Class members are Public unless declared otherwise.\n\nExample: `Public Function Total()`',

    // ── Statements ────────────────────────────────────────────────────────────
    'rem':       '**Rem** — Starts a comment, like `\'`.\n\nExample: `Rem Load the user`',
    'stop':      '**Stop** — Pauses at this line when a script debugger is attached; otherwise it does nothing.',
    'randomize': '**Randomize** — Seeds the random numbers `Rnd` returns. Call it once before using `Rnd`, or each run gives the same sequence.\n\nExample: `Randomize\ndie = Int(Rnd * 6) + 1`',

    // ── Operators ─────────────────────────────────────────────────────────────
    'and': '**And** — True when both sides are true; on numbers, a bitwise AND. VBScript always evaluates both sides — it does not stop early.\n\nExample: `If Not rs Is Nothing Then If Not rs.EOF Then ...` rather than one `And`',
    'or':  '**Or** — True when either side is true; on numbers, a bitwise OR. Both sides are always evaluated.\n\nExample: `If x = 1 Or x = 2 Then`',
    'not': '**Not** — The opposite of a condition; on numbers, a bitwise NOT.\n\nExample: `Do While Not rs.EOF`',
    'xor': '**Xor** — True when exactly one side is true; on numbers, a bitwise exclusive OR.\n\nExample: `If a Xor b Then`',
    'eqv': '**Eqv** — True when both sides are equal (both true or both false); on numbers, a bitwise equivalence.\n\nExample: `If a Eqv b Then`',
    'imp': '**Imp** — Logical implication: false only when the left side is true and the right side false.\n\nExample: `If a Imp b Then`',
    'is':  '**Is** — Tests whether two object variables refer to the same object.\n\nExample: `If rs Is Nothing Then`',
    'mod': '**Mod** — The remainder of a division. Both sides are rounded to whole numbers first.\n\nExample: `7 Mod 3` is `1`',

    // ── Values ────────────────────────────────────────────────────────────────
    'true':    '**True** — The Boolean true value. As a number it is `-1`.',
    'false':   '**False** — The Boolean false value. As a number it is `0`.',
    'null':    '**Null** — No valid data, such as a database field with no value. Anything compared with Null is Null, so test it with `IsNull`.\n\nExample: `If IsNull(rs("email")) Then`',
    'nothing': '**Nothing** — An object variable that refers to no object. Setting a variable to Nothing releases the object.\n\nExample: `Set rs = Nothing`',
    'empty':   '**Empty** — The value of a variable that has not been assigned; it counts as `0` and `""`. Test it with `IsEmpty`.\n\nExample: `If IsEmpty(total) Then total = 0`',
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
// Hover provider
// • VBScript context (<% %>): all hovers — keywords, symbols, COM members.
// • Script context (<script>):  symbol/COM hovers only, no keyword docs.
// • HTML context:               no hovers (except HTML link guard already applied).
// ─────────────────────────────────────────────────────────────────────────────
/** An intrinsic object's hover: what it is for, and its members by kind. */
function describeAspObject(object: AspObjectDef): string {
    const sections: string[] = [`**${object.name}** — ASP intrinsic object\n\n${object.description}.`];
    for (const [kind, heading] of [['method', 'Methods'], ['property', 'Properties'], ['collection', 'Collections']] as const) {
        const names = object.members.filter(member => member.kind === kind).map(member => `\`${member.name}\``);
        if (names.length > 0) { sections.push(`**${heading}:** ${names.join(', ')}`); }
    }
    return sections.join('\n\n');
}

/** True for a name VBScript or ASP provides, which a page rarely declares itself. */
function isBuiltinName(wordKey: string): boolean {
    return ASP_OBJECT_NAMES.has(wordKey) || wordKey in BUILTIN_FUNCTION_DOCS
        || VBSCRIPT_CONSTANTS.some(constant => constant.name.toLowerCase() === wordKey);
}

/** The declaration a hover describes: the one that runs, for a Sub written twice. */
function declarationFor(bound: BoundPage, target: Target): Declaration | undefined {
    const all = declarationsOf(bound.binding, target);
    const explicit = all.filter(d => !d.implicit);
    return explicit.length > 0 ? explicit[explicit.length - 1] : all[0];
}

/** What a hover says about a declaration the parser found. */
export function describeDeclaration(
    bound: BoundPage,
    decl: Declaration,
    docPath: string,
    comVariables: { name: string; progId: string }[],
): string {
    const page = bound.pages.get(pathKey(decl.file));
    const fromInclude = !samePath(decl.file, docPath);
    const where = (verb: string) => fromInclude ? `*${verb} in \`${path.basename(decl.file)}\`*` : `*${verb} in this file*`;
    const owner = decl.scope.node;
    const ownerName = owner?.name.text ?? '';

    if (decl.node?.kind === 'Procedure') {
        const proc = decl.node;
        const params = proc.paramList && page ? sourceOf(page.text, proc.paramList) : '';
        const word = PROCEDURE_WORD[proc.procKind] + (proc.accessor ? ` ${proc.accessor[0].toUpperCase()}${proc.accessor.slice(1)}` : '');
        const header = `**${word} ${proc.name.text}${params ? `(${params})` : ''}**`;
        const member = owner?.kind === 'Class' ? `\n\n*Member of class \`${ownerName}\`*` : '';
        return `${header}${member}\n\n${where('Defined')}`;
    }
    if (decl.node?.kind === 'Class') {
        return `**Class ${decl.node.name.text}**\n\n${where('Defined')}`;
    }

    if (decl.kind === 'constant') {
        const value = page && constantValue(page, decl);
        return `**${decl.text}**${value ? ` = \`${value}\`` : ' — constant'}\n\n${where('Declared')}`;
    }
    if (decl.kind === 'parameter') {
        return `**${decl.text}** — parameter of \`${ownerName}\``;
    }

    const com = comVariables.find(cv => cv.name.toLowerCase() === decl.name);
    if (com) {
        return `**${decl.text}** — \`${com.progId}\`\n\n${where('Declared')}\n\nType \`${decl.text}.\` to see available members.`;
    }
    const what = owner?.kind === 'Procedure' ? `local variable of \`${ownerName}\``
        : owner?.kind === 'Class' ? `member of class \`${ownerName}\``
        : 'variable';
    return `**${decl.text}** — ${what}\n\n${where('Declared')}`;
}

/** The value a Const gives its name, as written. */
function constantValue(page: ParsedPage, decl: Declaration): string | undefined {
    let value: string | undefined;
    for (const program of page.programs) {
        walkStatements(program.body, s => {
            if (s.kind !== 'Const') { return; }
            const d = s.declarators.find(x => x.name.start === decl.span.start);
            if (d) { value = sourceOf(page.text, d.value); }
        });
    }
    return value;
}

export class AspHoverProvider implements vscode.HoverProvider {

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): Promise<vscode.Hover | null | undefined> {

        const lineText = document.lineAt(position.line).text;

        // Suppress hover inside HTML file-link attributes (href, src, etc.)
        if (isCursorInHtmlFileLinkAttribute(lineText, position.character)) return null;

        // A word inside a VBScript string or comment is text, not a name, so
        // `Case "Active"` and `' uses Split here` get no hover. The line is read
        // from where its VBScript starts, so an apostrophe in the HTML around a
        // block (`<div class='box'><% If x Then %>`) is not taken for a comment.
        const caret = contextAt(document, position);
        if (caret.zone !== 'asp' || caret.inVbStringOrComment) return null;
        const fullText = textOf(document);

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const word    = document.getText(wordRange);
        const wordKey = word.toLowerCase();

        // The page's own symbols as the VBScript worker read them, as completion
        // takes them, rather than parsing the page again here; then its includes'.
        const version = document.version;
        const page = await analysedPage(document, token);
        if (!page || token?.isCancellationRequested || document.version !== version) { return null; }
        const allSymbols = withIncludeSymbols(document, page.symbols);

        // ── 1. COM member after dot — e.g. rs.EOF, conn.Execute ──────────────
        // A bare `.EOF` inside `With rs` is a member of rs.
        const charBeforeWord = lineText.charAt(wordRange.start.character - 1);
        if (charBeforeWord === '.') {
            const textBeforeDot = lineText.substring(0, wordRange.start.character - 1);
            const withObject    = () => /^[A-Za-z_]\w*$/.exec(enclosingWithObject(fullText, position.line, wordRange.start.character) ?? '')?.[0];
            const objectName    = /\b(\w+)$/.exec(textBeforeDot)?.[1] ?? (/[)\]]$/.test(textBeforeDot) ? undefined : withObject());
            if (objectName) {
                const objName    = objectName.toLowerCase();

                // An intrinsic object first: Response, Request, Server and the
                // rest are always in scope and are never declared, so they will
                // not be among the collected symbols.
                const aspMember = ASP_MEMBER_DOCS[`${objName}.${wordKey}`];
                if (aspMember) {
                    return new vscode.Hover(
                        new vscode.MarkdownString(
                            `**${aspMember.label}** *(${aspMember.kind})*\n\n${aspMember.doc}`,
                        )
                    );
                }

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

        // ── 2. A name the page declares ───────────────────────────────────────
        // The parser says which declaration the name means: a local, a
        // parameter, a page variable, a procedure or a class member.
        if (!VBSCRIPT_KEYWORDS_SET.has(wordKey)) {
            const resolved = resolveAt(
                editorWorkspace(document), document.uri.fsPath, document.offsetAt(wordRange.start), !isBuiltinName(wordKey),
            );
            const decl = resolved && declarationFor(resolved.bound, resolved.target);
            if (resolved && decl) {
                return new vscode.Hover(new vscode.MarkdownString(
                    describeDeclaration(resolved.bound, decl, document.uri.fsPath, allSymbols.comVariables),
                ));
            }
        }

        // After a dot the word is a member of some object. Its docs, when known,
        // were found above; a variable or function of the same name is not it.
        if (charBeforeWord === '.') return null;

        // ── 3. Intrinsic object — Response, Request, Server, Session, … ─────────
        // Always in scope and never declared, so never among the symbols above.
        // After a dot the word is a member of something else (`obj.Response`).
        const aspObject = charBeforeWord === '.'
            ? undefined
            : ASP_OBJECTS.find(object => object.name.toLowerCase() === wordKey);
        if (aspObject) {
            return new vscode.Hover(new vscode.MarkdownString(describeAspObject(aspObject)));
        }

        // ── 4. Built-in VBScript constant — vbCrLf, vbTextCompare, … ────────────
        const vbConstant = VBSCRIPT_CONSTANTS.find(constant => constant.name.toLowerCase() === wordKey);
        if (vbConstant) {
            return new vscode.Hover(
                new vscode.MarkdownString(`**${vbConstant.name}** — VBScript constant\n\n${vbConstant.doc}`)
            );
        }

        // ── 5. Built-in VBScript function hover ─────────────────────────────────
        // Show docs for built-in functions like Split(), InStr(), DateDiff(), etc.
        if (BUILTIN_FUNCTION_DOCS[wordKey]) {
            return new vscode.Hover(new vscode.MarkdownString(BUILTIN_FUNCTION_DOCS[wordKey]));
        }

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