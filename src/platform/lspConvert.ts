/**
 * lspConvert.ts
 *
 * The CSS and HTML language services and the Emmet helper answer in the
 * Language Server Protocol's shapes; these turn them into VS Code's. One copy,
 * so a completion, a hover or a range reads the same whichever service it
 * came from.
 *
 * The shapes are written out here rather than imported, so this module does
 * not load a language service package just to name its types.
 */

import * as vscode from 'vscode';

export interface LspRange {
    start: { line: number; character: number };
    end:   { line: number; character: number };
}

export interface LspMarkupContent { kind: string; value: string; }
/** The older hover shape: text, or code in a language. */
export type LspMarkedString = string | { language: string; value: string };

export interface LspCompletionItem {
    label: string | { label: string };
    kind?: number;
    detail?: string;
    documentation?: string | LspMarkupContent;
    insertText?: string;
    insertTextFormat?: number;
    textEdit?: { newText: string; range: LspRange } | { newText: string; insert: LspRange; replace: LspRange };
    filterText?: string;
    sortText?: string;
}

/** LSP's InsertTextFormat.Snippet. */
const SNIPPET_FORMAT = 2;

export function fromLspRange(range: LspRange): vscode.Range {
    return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** LSP numbers its completion kinds from 1, VS Code from 0; otherwise they are the same list. */
export function fromLspKind(kind: number | undefined, fallback: vscode.CompletionItemKind): vscode.CompletionItemKind {
    return kind ? kind - 1 : fallback;
}

/** Hover or documentation content, in any of the shapes LSP allows, as one Markdown string. */
export function fromLspMarkdown(contents: LspMarkupContent | LspMarkedString | LspMarkedString[]): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    const parts = Array.isArray(contents) ? contents : [contents];
    parts.forEach((part, index) => {
        if (index > 0) { markdown.appendMarkdown('\n\n'); }
        if (typeof part === 'string') { markdown.appendMarkdown(part); }
        else if ('kind' in part) { if (part.kind === 'markdown') { markdown.appendMarkdown(part.value); } else { markdown.appendText(part.value); } }
        else { markdown.appendCodeblock(part.value, part.language); }
    });
    return markdown;
}

export interface CompletionOptions {
    /** The kind when the item has none. */
    kind: vscode.CompletionItemKind;
    /**
     * Take the range the item replaces from its edit. Only when the service read
     * the page itself, line for line: a range in a document built for the
     * service (an inline style) is not a range of the page.
     */
    useRange?: boolean;
    /** Treat the text as a snippet whatever the item says (Emmet's always are). */
    snippet?: boolean;
}

/**
 * A completion item as VS Code takes it. The text to insert is the edit's when
 * there is one — the CSS service and Emmet put it there, not in insertText.
 */
export function fromLspCompletion(item: LspCompletionItem, options: CompletionOptions): vscode.CompletionItem {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    const converted = new vscode.CompletionItem(label, item.kind ? fromLspKind(item.kind, options.kind) : options.kind);

    const text = item.textEdit?.newText || item.insertText || label;
    converted.insertText = options.snippet || item.insertTextFormat === SNIPPET_FORMAT ? new vscode.SnippetString(text) : text;

    const edit = item.textEdit;
    if (options.useRange && edit) { converted.range = fromLspRange('range' in edit ? edit.range : edit.replace); }

    if (item.detail)        { converted.detail = item.detail; }
    if (item.documentation) {
        converted.documentation = typeof item.documentation === 'string' ? item.documentation : fromLspMarkdown(item.documentation);
    }
    if (item.filterText)    { converted.filterText = item.filterText; }
    if (item.sortText)      { converted.sortText = item.sortText; }
    return converted;
}
