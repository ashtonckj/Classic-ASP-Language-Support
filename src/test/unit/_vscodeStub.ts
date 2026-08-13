// Minimal stand-in for the 'vscode' module used by the plain-mocha unit harness.
//
// Several provider/formatter files `import * as vscode from 'vscode'` at the top.
// The real module only exists inside the Extension Host, so _mochaSetup.ts
// redirects require('vscode') here. We expose just enough surface for the PURE
// logic under test to run:
//   • workspace.getConfiguration(...).get(key, default) → returns the default, so
//     getAspSettings()/getPrettierSettings() yield the documented defaults.
//   • window.* → no-ops (warnings, progress, output channels) so formatting can
//     run headlessly; withProgress simply invokes and returns its task.
// Anything that needs real editor behaviour must run in the Extension Host.

export const workspace = {
    getConfiguration: () => ({
        get: (_key: string, defaultValue?: unknown) => defaultValue,
    }),
};

export const window = {
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    withProgress: (_opts: unknown, task: (progress: { report: () => void }) => unknown) =>
        task({ report: () => { /* no-op */ } }),
    createOutputChannel: () => ({
        clear: () => { /* no-op */ },
        append: () => { /* no-op */ },
        appendLine: () => { /* no-op */ },
        show: () => { /* no-op */ },
        dispose: () => { /* no-op */ },
    }),
};

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

// Referenced by a static initializer in htmlStructureDiagnosticsProvider
// (VoidElementQuickFixProvider.providedCodeActionKinds) at module-load time.
export const CodeActionKind = { QuickFix: { value: 'quickfix' } };

// ── Value types ──────────────────────────────────────────────────────────────
// Enough of the vscode value classes for providers that BUILD results (rather
// than only reading a document) to run headlessly: the structure scanners return
// Diagnostics, the symbol provider returns DocumentSymbols. Behaviour matches the
// real classes for the plain-data uses the tests make of them.

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(public readonly start: Position, public readonly end: Position) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class Diagnostic {
    public source?: string;
    public code?: string | number;
    constructor(
        public readonly range: Range,
        public readonly message: string,
        public readonly severity?: number,
    ) {}
}

export const SymbolKind = {
    File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
    Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
    Function: 11, Variable: 12, Constant: 13, String: 14,
};

export class DocumentSymbol {
    public children: DocumentSymbol[] = [];
    constructor(
        public readonly name: string,
        public readonly detail: string,
        public readonly kind: number,
        public readonly range: Range,
        public readonly selectionRange: Range,
    ) {}
}
