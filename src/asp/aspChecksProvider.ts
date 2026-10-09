import * as vscode from 'vscode';
import type { Check, CheckCode } from '../vbscript/checks';
import { makeDiagnostic } from '../platform/diagnostics';

// ─────────────────────────────────────────────────────────────────────────────
// The checks the parser makes possible (src/vbscript/checks.ts): a name
// declared twice, an undeclared name under Option Explicit, a call with the
// wrong number of arguments, a local never used, and code after an Exit.
// They are worked out on the VBScript worker thread (vbscript/pageChecks.ts)
// and go in the checks collection, which does not stop Format Document.
// ─────────────────────────────────────────────────────────────────────────────

/** Unused and unreachable code is faded, the way VS Code shows it elsewhere, rather than underlined. */
const FADED: ReadonlySet<CheckCode> = new Set(['unused', 'unreachable']);

/** The checks as diagnostics on `document`, whose text they were worked out from. */
export function parserCheckDiagnostics(document: vscode.TextDocument, checks: Check[]): vscode.Diagnostic[] {
    return checks.map(check => {
        const faded = FADED.has(check.code);
        return makeDiagnostic(
            new vscode.Range(document.positionAt(check.start), document.positionAt(check.end)),
            check.message,
            faded ? vscode.DiagnosticSeverity.Hint : vscode.DiagnosticSeverity.Warning,
            check.code,
            faded ? [vscode.DiagnosticTag.Unnecessary] : undefined,
        );
    });
}
