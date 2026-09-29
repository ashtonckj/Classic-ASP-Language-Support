import * as vscode from 'vscode';
import * as path from 'path';
import { getVirtualRoot, readIncludeText } from './includeProvider';
import { editorWorkspace } from './vbscriptWorkspace';
import { ASP_OBJECT_NAMES, VBSCRIPT_CONSTANTS, VBSCRIPT_FUNCTIONS } from '../constants/aspKeywords';
import { checkPage, objectTagIds, type CheckCode } from '../vbscript/checks';
import { bindAt } from '../vbscript/references';

// ─────────────────────────────────────────────────────────────────────────────
// The checks the parser makes possible (src/vbscript/checks.ts): a name
// declared twice, an undeclared name under Option Explicit, a call with the
// wrong number of arguments, a local never used, and code after an Exit.
// They go in the checks collection, which does not stop Format Document.
// ─────────────────────────────────────────────────────────────────────────────

/** The names a page may use without declaring them. */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
    ...ASP_OBJECT_NAMES,
    ...VBSCRIPT_FUNCTIONS.map(name => name.toLowerCase()),
    ...VBSCRIPT_CONSTANTS.map(constant => constant.name.toLowerCase()),
    // VBScript's one built-in class, as in `Set re = New RegExp`.
    'regexp',
    // A statement, though it reads like a call of a Sub.
    'randomize',
]);

/** Unused and unreachable code is faded, the way VS Code shows it elsewhere, rather than underlined. */
const FADED: ReadonlySet<CheckCode> = new Set(['unused', 'unreachable']);

export function scanParserChecks(document: vscode.TextDocument): vscode.Diagnostic[] {
    const docPath = document.uri.fsPath;
    const bound = bindAt(editorWorkspace(document), docPath);
    if (!bound) { return []; }

    // An <object runat="server"> in global.asa gives every page that object.
    const globalAsa = readIncludeText(path.join(getVirtualRoot(docPath), 'global.asa'));
    const builtins = globalAsa ? new Set([...BUILTIN_NAMES, ...objectTagIds(globalAsa)]) : BUILTIN_NAMES;

    return checkPage(bound, docPath, builtins).map(check => {
        const faded = FADED.has(check.code);
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(document.positionAt(check.start), document.positionAt(check.end)),
            check.message,
            faded ? vscode.DiagnosticSeverity.Hint : vscode.DiagnosticSeverity.Warning,
        );
        if (faded) { diagnostic.tags = [vscode.DiagnosticTag.Unnecessary]; }
        diagnostic.source = 'Classic ASP';
        diagnostic.code = check.code;
        return diagnostic;
    });
}
