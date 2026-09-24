/**
 * jsTsKinds.ts  (utils/)
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
export function tsKindToVsKind(kind: string): vscode.CompletionItemKind {
    // Only JavaScript completion calls this, and it has TypeScript loaded already.
    const ts = require('typescript') as typeof import('typescript');
    switch (kind) {
        case ts.ScriptElementKind.functionElement:
        case ts.ScriptElementKind.localFunctionElement:
            return vscode.CompletionItemKind.Function;
        case ts.ScriptElementKind.memberFunctionElement:
        case ts.ScriptElementKind.callSignatureElement:
        case ts.ScriptElementKind.constructSignatureElement:
            return vscode.CompletionItemKind.Method;
        case ts.ScriptElementKind.variableElement:
        case ts.ScriptElementKind.localVariableElement:
        case ts.ScriptElementKind.letElement:
        case ts.ScriptElementKind.constElement:
            return vscode.CompletionItemKind.Variable;
        case ts.ScriptElementKind.classElement:
        case ts.ScriptElementKind.localClassElement:
            return vscode.CompletionItemKind.Class;
        case ts.ScriptElementKind.interfaceElement:
            return vscode.CompletionItemKind.Interface;
        case ts.ScriptElementKind.enumElement:
            return vscode.CompletionItemKind.Enum;
        case ts.ScriptElementKind.enumMemberElement:
            return vscode.CompletionItemKind.EnumMember;
        case ts.ScriptElementKind.moduleElement:
        case ts.ScriptElementKind.externalModuleName:
            return vscode.CompletionItemKind.Module;
        case ts.ScriptElementKind.memberVariableElement:
        case ts.ScriptElementKind.memberGetAccessorElement:
        case ts.ScriptElementKind.memberSetAccessorElement:
            return vscode.CompletionItemKind.Field;
        case ts.ScriptElementKind.typeElement:
        case ts.ScriptElementKind.typeParameterElement:
            return vscode.CompletionItemKind.TypeParameter;
        case ts.ScriptElementKind.keyword:
            return vscode.CompletionItemKind.Keyword;
        case ts.ScriptElementKind.string:
            return vscode.CompletionItemKind.Value;
        default:
            return vscode.CompletionItemKind.Property;
    }
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
