/**
 * jsTsKinds.ts  (js/)
 *
 * The two mappings from TypeScript's own enums to VS Code's. They live apart
 * from jsUtils.ts on purpose: everything else in there — the virtual-file
 * builder, the <script> scanner, the language service — has to be importable
 * from a worker thread, and a worker cannot import the vscode module at all.
 * These two are the only places that needed it, so they moved out rather than
 * holding the rest hostage.
 */

import * as vscode from 'vscode';
import type * as ts from 'typescript';

// ─────────────────────────────────────────────────────────────────────────────
// ts.ScriptElementKind → vscode.CompletionItemKind
// ─────────────────────────────────────────────────────────────────────────────
// TypeScript's own ScriptElementKind strings, part of its public API. Named
// through the enum, they would load all of TypeScript onto the extension host
// (~200 ms), which otherwise never needs it: the service is on the JS worker.
// The template-literal key type makes tsc check every string against the enum.
// A Map rather than an object: 'constructor' is a kind too, and an object
// would answer it with Object.prototype.constructor.
const COMPLETION_KINDS = new Map<`${ts.ScriptElementKind}`, vscode.CompletionItemKind>([
    ['function',             vscode.CompletionItemKind.Function],
    ['local function',       vscode.CompletionItemKind.Function],
    ['method',               vscode.CompletionItemKind.Method],
    ['call',                 vscode.CompletionItemKind.Method],
    ['construct',            vscode.CompletionItemKind.Method],
    ['var',                  vscode.CompletionItemKind.Variable],
    ['local var',            vscode.CompletionItemKind.Variable],
    ['let',                  vscode.CompletionItemKind.Variable],
    ['const',                vscode.CompletionItemKind.Variable],
    ['class',                vscode.CompletionItemKind.Class],
    ['local class',          vscode.CompletionItemKind.Class],
    ['interface',            vscode.CompletionItemKind.Interface],
    ['enum',                 vscode.CompletionItemKind.Enum],
    ['enum member',          vscode.CompletionItemKind.EnumMember],
    ['module',               vscode.CompletionItemKind.Module],
    ['external module name', vscode.CompletionItemKind.Module],
    ['property',             vscode.CompletionItemKind.Field],
    ['getter',               vscode.CompletionItemKind.Field],
    ['setter',               vscode.CompletionItemKind.Field],
    ['type',                 vscode.CompletionItemKind.TypeParameter],
    ['type parameter',       vscode.CompletionItemKind.TypeParameter],
    ['keyword',              vscode.CompletionItemKind.Keyword],
    ['string',               vscode.CompletionItemKind.Value],
]);

export function tsKindToVsKind(kind: string): vscode.CompletionItemKind {
    return COMPLETION_KINDS.get(kind as ts.ScriptElementKind) ?? vscode.CompletionItemKind.Property;
}

// ─────────────────────────────────────────────────────────────────────────────
// ts.DiagnosticCategory → vscode.DiagnosticSeverity
// ─────────────────────────────────────────────────────────────────────────────
export function tsSeverityToVs(category: ts.DiagnosticCategory): vscode.DiagnosticSeverity {
    // TypeScript's own DiagnosticCategory numbers, part of its public API. The
    // squiggles get only these plain numbers back from the worker thread, and
    // naming them through the enum loaded all of TypeScript onto the extension
    // host to read four constants.
    switch (category) {
        case 1 /* Error */:      return vscode.DiagnosticSeverity.Error;
        case 0 /* Warning */:    return vscode.DiagnosticSeverity.Warning;
        case 2 /* Suggestion */: return vscode.DiagnosticSeverity.Hint;
        case 3 /* Message */:    return vscode.DiagnosticSeverity.Information;
        default:                 return vscode.DiagnosticSeverity.Warning;
    }
}
