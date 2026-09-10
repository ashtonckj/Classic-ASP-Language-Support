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
    // Mutable so a test can stand in a workspace root (getVirtualRoot reads it).
    workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
    // collectAllSymbols evicts its cache by walking the open documents.
    textDocuments: [] as unknown[],
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
    ) {
        // The real class validates this and throws, which is how an unnamed
        // symbol took down the whole Outline. Reproduce it so a unit test can
        // catch that rather than waiting for the Extension Host.
        if (!name) { throw new Error('name must not be falsy'); }
    }
}

// ── Editing types ────────────────────────────────────────────────────────────
// computeLineEdits builds TextEdits and reads document.eol, so both need to
// exist for the plain-mocha harness.

export const EndOfLine = { LF: 1, CRLF: 2 };

export class TextEdit {
    constructor(public readonly range: Range, public readonly newText: string) {}
    static replace(range: Range, newText: string): TextEdit { return new TextEdit(range, newText); }
}

// ── Colours ──────────────────────────────────────────────────────────────────
// Channels are 0..1 floats, as the real API defines them.

export class Color {
    constructor(
        public readonly red: number,
        public readonly green: number,
        public readonly blue: number,
        public readonly alpha: number,
    ) {}
}

export class ColorInformation {
    constructor(public readonly range: Range, public readonly color: Color) {}
}

export class ColorPresentation {
    public textEdit?: TextEdit;
    public additionalTextEdits?: TextEdit[];
    constructor(public readonly label: string) {}
}

// ── Navigation ───────────────────────────────────────────────────────────────
// Location, highlights and WorkspaceEdit, enough to run the JS definition /
// reference / rename providers headlessly. WorkspaceEdit keeps its edits keyed
// by uri.toString() so `size` and `get()` behave like the real class.

export class Location {
    constructor(public readonly uri: unknown, public readonly range: Range) {}
}

export const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };

export class DocumentHighlight {
    constructor(public readonly range: Range, public readonly kind: number = DocumentHighlightKind.Text) {}
}

export class WorkspaceEdit {
    private readonly _byFile = new Map<string, { uri: unknown; edits: TextEdit[] }>();

    private _key(uri: unknown): string { return String((uri as { toString(): string }).toString()); }

    replace(uri: unknown, range: Range, newText: string): void {
        const key = this._key(uri);
        const entry = this._byFile.get(key) ?? { uri, edits: [] };
        entry.edits.push(new TextEdit(range, newText));
        this._byFile.set(key, entry);
    }

    get(uri: unknown): TextEdit[] { return this._byFile.get(this._key(uri))?.edits ?? []; }

    /** Number of FILES touched, as the real class reports it. */
    get size(): number { return this._byFile.size; }

    entries(): Array<[unknown, TextEdit[]]> {
        return [...this._byFile.values()].map(e => [e.uri, e.edits] as [unknown, TextEdit[]]);
    }
}

// ── Semantic tokens ──────────────────────────────────────────────────────────
// Enough of the semantic-token surface to run AspSemanticTokensProvider headlessly.
// build() returns the pushed tokens as-is rather than the real delta encoding —
// tests assert on positions and types, which is what the encoding carries anyway.

export class SemanticTokensLegend {
    constructor(
        public readonly tokenTypes: string[],
        public readonly tokenModifiers: string[],
    ) {}
}

export interface StubSemanticToken {
    line: number; char: number; len: number; type: number; mod: number;
}

export class SemanticTokensBuilder {
    public readonly tokens: StubSemanticToken[] = [];
    constructor(public readonly legend?: SemanticTokensLegend) {}
    push(line: number, char: number, len: number, type: number, mod: number): void {
        this.tokens.push({ line, char, len, type, mod });
    }
    build(): { tokens: StubSemanticToken[]; data: Uint32Array } {
        return { tokens: this.tokens, data: new Uint32Array() };
    }
}

export const languages = {
    createDiagnosticCollection: () => ({
        set() { /* no-op */ }, delete() { /* no-op */ },
        get: () => [], dispose() { /* no-op */ },
    }),
};

export const Uri = {
    file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
};
