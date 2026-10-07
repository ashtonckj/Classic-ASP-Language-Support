/**
 * diagnostics.ts
 *
 * How every problem the extension reports is named, built and scheduled.
 *
 * Every diagnostic has the one source, "Classic ASP", and a code that says
 * what kind of problem it is, so the Problems panel reads alike for all of
 * them and can be filtered by code. The codes are kebab-case words, except
 * the JavaScript ones, which are TypeScript's own numbers (2339 …): those are
 * what TypeScript's quick fixes are asked for, and what its documentation uses.
 *
 * Each kind of check runs on every open ASP page: at once for the pages already
 * open, then a while after the last edit of a page, and its problems are taken
 * away when the page closes. watchAspDocuments does that the same way for all
 * of them.
 */

import * as vscode from 'vscode';
import type { CheckCode } from '../vbscript/checks';

export const DIAGNOSTIC_SOURCE = 'Classic ASP';

/** The code of every kind of problem, other than the parser's checks (CheckCode) and JavaScript's numbers. */
export const DiagnosticCode = {
    /** A VBScript block with no closer, or a closer with no block. */
    vbscriptBlock:      'vbscript-block',
    /** A `%>` outside every block, or a `<%` never closed. */
    aspTag:             'asp-tag',
    /** A structural HTML tag with no partner. */
    htmlTag:            'html-tag',
    /** `</br>` and the like: a closing tag for an element that has none. */
    htmlVoidClosingTag: 'html-void-closing-tag',
    missingInclude:     'missing-include',
    missingSet:         'missing-set',
    /** Where the SQL colouring may be incomplete. */
    sql:                'sql-highlighting',
} as const;

export type Code = typeof DiagnosticCode[keyof typeof DiagnosticCode] | CheckCode | `css-${string}` | number;

/**
 * The problems that stop Format Document: formatting a page whose tags or
 * blocks do not pair up would put them back in the wrong places.
 */
export const BLOCKS_FORMATTING: ReadonlySet<Code> = new Set<Code>([
    DiagnosticCode.vbscriptBlock, DiagnosticCode.aspTag, DiagnosticCode.htmlTag, DiagnosticCode.htmlVoidClosingTag,
]);

/** A CSS service code (`unknownProperties`) as one of ours (`css-unknown-properties`). */
export function cssCode(serviceCode: string | number): `css-${string}` {
    return `css-${String(serviceCode).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
}

/** A diagnostic with the extension's source and the given code. */
export function makeDiagnostic(
    range: vscode.Range,
    message: string,
    severity: vscode.DiagnosticSeverity,
    code: Code,
    tags?: vscode.DiagnosticTag[],
): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = code;
    if (tags) { diagnostic.tags = tags; }
    return diagnostic;
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/** How long after the last edit each check runs, in milliseconds. */
export const CHECK_DELAY = {
    /** CSS validation, a quick local parse. */
    css:       400,
    /** JavaScript, checked by TypeScript on a worker thread. */
    js:        750,
    /** Tag and block pairing, missing includes and the parser's checks. */
    structure: 1500,
} as const;

/** One timer per document: a new request for a page replaces its waiting one, and leaves other pages' alone. */
export class DocumentDebouncer implements vscode.Disposable {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly delay: number, private readonly run: (document: vscode.TextDocument) => void) {}

    schedule(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            if (!document.isClosed) { this.run(document); }
        }, this.delay));
    }

    cancel(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
    }

    dispose(): void {
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
    }
}

export interface AspDocumentWatch {
    /** How long after the last edit `check` runs. */
    delay: number;
    /** Works out and publishes a page's problems. */
    check(document: vscode.TextDocument): void;
    /** For the pages open when the extension starts, if not `check`. */
    initial?(document: vscode.TextDocument): void;
    /** True to check a page the moment it opens rather than after `delay`. */
    checkOnOpen?: boolean;
    /** The collections whose entry for a page goes when the page closes. */
    collections: vscode.DiagnosticCollection[];
}

/**
 * Runs a check on every open ASP page: at once for those open now, then after
 * each edit (and on open), and clears its problems when a page closes.
 * Returns the debouncer, for a caller that schedules a check of its own.
 */
export function watchAspDocuments(context: vscode.ExtensionContext, watch: AspDocumentWatch): DocumentDebouncer {
    const debouncer = new DocumentDebouncer(watch.delay, watch.check);
    const isAsp = (document: vscode.TextDocument) => document.languageId === 'asp';

    for (const document of vscode.workspace.textDocuments) {
        if (isAsp(document)) { (watch.initial ?? watch.check)(document); }
    }

    context.subscriptions.push(
        debouncer,
        vscode.workspace.onDidOpenTextDocument(document => {
            if (!isAsp(document)) { return; }
            if (watch.checkOnOpen) { watch.check(document); } else { debouncer.schedule(document); }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (isAsp(event.document)) { debouncer.schedule(event.document); }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            debouncer.cancel(document);
            for (const collection of watch.collections) { collection.delete(document.uri); }
        }),
    );
    return debouncer;
}
