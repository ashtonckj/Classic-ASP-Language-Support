/**
 * jsCompletionProvider.ts  (js/)
 *
 * TypeScript Language Service completions for <script> blocks, asked of the
 * JS worker (jsDocument's askJs).
 *
 * What resolveCompletionItem needs is kept on item.data.
 *
 * Trigger characters registered in jsFeatures.ts: '.', '('
 *
 * That set is OURS, not TypeScript's: '(' is registered so the suggestion list
 * reopens on a call, but TypeScript's completion API rejects any trigger outside
 * its own small set. jsUtils' isTsTriggerCharacter is what keeps the two apart —
 * a character it does not recognise is dropped before the language service sees
 * it, which still yields the plain position-based list wanted after '('.
 *
 * isIncomplete strategy:
 *   • After '.' the list is complete — VS Code's prefix filter handles narrowing,
 *     so we return isIncomplete:false.
 *   • Mid-word (no trigger char, or after a space) we return isIncomplete:true so
 *     VS Code re-requests on every keystroke until the prefix is >= 2 chars.
 *
 * Entries prefixed with _asp_ or matching the bare catch-all `_asp` are filtered
 * out — these are internal projection variables and should never appear in
 * user-facing suggestions.
 */

import * as vscode from 'vscode';
import { textOf } from '../platform/documentState';
import { askJs, jsDocMarkdown, jsOffsetAt } from './jsDocument';
import { tsKindToVsKind } from './jsTsKinds';

interface ItemData {
    document: vscode.TextDocument;
    name:     string;
    /** The caret the list was worked out for, as a page offset. */
    offset:   number;
    source?:  string;
    /** True when the entry kind is Function or Method — used in resolveCompletionItem
     *  to decide whether to inject a call-snippet. */
    isFunctionLike: boolean;
}

/** Characters that signal we are starting a fresh expression context. */
const FRESH_CONTEXT_CHARS = new Set([' ', '\t', '\n', ';', '{', '}', '(', ',', '[', '=', '!', '&', '|', '+', '-', '*', '/', '%', '?', ':']);

export class JsCompletionProvider implements vscode.CompletionItemProvider {

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken,
        context:  vscode.CompletionContext,
    ): Promise<vscode.CompletionList | undefined> {

        const offset = jsOffsetAt(document, position);
        if (offset === undefined) { return undefined; }
        const text = textOf(document);

        // ── Determine trigger character ──────────────────────────────────────
        const explicitTrigger = context.triggerCharacter;
        // The character before the caret.
        const prevChar        = offset > 0 ? text[offset - 1] : '';
        const triggerChar     = explicitTrigger ?? (prevChar === '.' ? '.' : undefined);

        const completions = await askJs(document, 'getCompletions', [offset, triggerChar], token);
        if (!completions) { return undefined; }

        const items = completions.entries
            // Internal projection variables must never surface to the user.
            .filter(e => !e.name.startsWith('_asp_') && e.name !== '_asp')
            // A function that has no name yet — the moment after `function` is
            // typed and before the name is — is offered by TypeScript as a
            // global completion whose name is the empty string. Built into a
            // CompletionItem it becomes an item with no label, which VS Code
            // discards with "did IGNORE invalid completion item" in the log.
            // Harmless, but it is one item of the list wasted on every keystroke
            // while a function is being named, and the warning is noise that
            // looks like a bug in this extension.
            .filter(e => e.name !== '')
            .map(entry => {
            const item      = new vscode.CompletionItem(entry.name, tsKindToVsKind(entry.kind));
            item.sortText   = '0' + (entry.sortText ?? entry.name);
            item.filterText = entry.name;

            if (entry.insertText) {
                item.insertText = entry.isSnippet
                    ? new vscode.SnippetString(entry.insertText)
                    : entry.insertText;
            }

            if (item.kind === vscode.CompletionItemKind.Function ||
                item.kind === vscode.CompletionItemKind.Method) {
                item.commitCharacters = ['('];
            }

            const isFunctionLike = item.kind === vscode.CompletionItemKind.Function
                                 || item.kind === vscode.CompletionItemKind.Method;

            (item as any).data = { document, name: entry.name, offset, source: entry.source, isFunctionLike } satisfies ItemData;

            return item;
        });

        // ── isIncomplete decision ────────────────────────────────────────────
        const afterDot       = triggerChar === '.';
        const inFreshContext = FRESH_CONTEXT_CHARS.has(prevChar) || prevChar === '';
        const incomplete     = !afterDot && inFreshContext;

        return new vscode.CompletionList(items, incomplete);
    }

    async resolveCompletionItem(
        item:  vscode.CompletionItem,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem> {

        const data = (item as any).data as ItemData | undefined;
        if (!data || data.document.isClosed) { return item; }

        // Asked of the page as it is now, at the offset the list was worked out
        // for, as VS Code's own TypeScript support resolves an item. The page
        // may have moved on by a keystroke or two since; asking about the text
        // the list came from would load that back into the service, and the
        // next request would then re-check the whole page twice over.
        const details = await askJs(data.document, 'getCompletionDetails', [data.name, data.offset, data.source], token);
        if (!details) { return item; }

        const displayText = details.displayParts?.map(p => p.text).join('') ?? '';
        const docs        = jsDocMarkdown(details.documentation, details.tags);

        if (displayText) { item.detail = displayText; }
        if (docs) { item.documentation = new vscode.MarkdownString(docs, true); }

        // ── Call-snippet injection ───────────────────────────────────────────
        if (data.isFunctionLike && !item.insertText) {
            const parts     = details.displayParts ?? [];
            const openIdx   = parts.findIndex(p => p.kind === 'punctuation' && p.text === '(');
            const closeIdx  = parts.findIndex(p => p.kind === 'punctuation' && p.text === ')');
            const hasParams = openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx + 1;

            item.insertText = new vscode.SnippetString(
                hasParams ? `${data.name}($0)` : `${data.name}()$0`
            );
        }

        return item;
    }
}