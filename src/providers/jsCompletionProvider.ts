/**
 * jsCompletionProvider.ts  (providers/)
 *
 * TypeScript Language Service completions for <script> blocks.
 *
 * Resolution data is stored on item.data so it survives VS Code's internal
 * serialize/deserialize cycle between provideCompletionItems and resolveCompletionItem.
 *
 * Trigger characters registered in extension.ts: '.', '(', '[', ' '
 *
 * isIncomplete strategy:
 *   • After a trigger character ('.', '(', '[') the list is complete — VS Code's
 *     prefix filter handles narrowing, so we return isIncomplete:false.
 *   • Mid-word (no trigger char, or after a space) we return isIncomplete:true so
 *     VS Code re-requests on every keystroke until the prefix is >= 2 chars.
 *
 * Entries prefixed with _asp_ or matching the bare catch-all `_asp` are filtered
 * out — these are internal projection variables and should never appear in
 * user-facing suggestions.
 */

import * as vscode from 'vscode';
import { buildVirtualJsContent, getJsLanguageService, tsKindToVsKind, } from '../utils/jsUtils';
import { getZone } from '../utils/zoneUtils';

interface ItemData {
    name:    string;
    /** Offset already adjusted to virtual-file space (i.e. raw offset + preambleLength). */
    offset:  number;
    source?: string;
    /** True when the entry kind is Function or Method — used in resolveCompletionItem
     *  to decide whether to inject a call-snippet. */
    isFunctionLike: boolean;
}

/** Characters that signal we are starting a fresh expression context. */
const FRESH_CONTEXT_CHARS = new Set([' ', '\t', '\n', ';', '{', '}', '(', ',', '[', '=', '!', '&', '|', '+', '-', '*', '/', '%', '?', ':']);

export class JsCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken,
        context:  vscode.CompletionContext,
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const fullText = document.getText();
        const offset  = document.offsetAt(position);
        const { virtualContent, isInScript, preambleLength } = buildVirtualJsContent(fullText, offset);

        if (getZone(fullText, offset) !== 'js') { return undefined; }
        if (!isInScript || token.isCancellationRequested) { return undefined; }

        // ── Determine trigger character ──────────────────────────────────────
        const explicitTrigger = context.triggerCharacter;
        // FIX: prevChar must be looked up in the virtual content at the
        // preamble-shifted position so string/comment state is correct.
        const virtualOffset   = offset + preambleLength;
        const prevChar        = virtualOffset > 0 ? virtualContent[virtualOffset - 1] : '';
        const triggerChar     = explicitTrigger ?? (prevChar === '.' ? '.' : undefined);

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        // Shift offset into virtual-file space
        const completions = svc.getCompletions(virtualOffset, triggerChar);
        if (!completions || token.isCancellationRequested) { return undefined; }

        const items = completions.entries
            // Internal projection variables must never surface to the user.
            .filter(e => !e.name.startsWith('_asp_') && e.name !== '_asp')
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

            // Store the virtual-file offset (already preamble-shifted) so
            // resolveCompletionItem can pass it straight to the TS service.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (item as any).data = { name: entry.name, offset: virtualOffset, source: entry.source, isFunctionLike } satisfies ItemData;

            return item;
        });

        // ── isIncomplete decision ────────────────────────────────────────────
        const afterDotOrBracket = triggerChar === '.' || triggerChar === '[';
        const inFreshContext    = FRESH_CONTEXT_CHARS.has(prevChar) || prevChar === '';
        const incomplete        = !afterDotOrBracket && inFreshContext;

        return new vscode.CompletionList(items, incomplete);
    }

    resolveCompletionItem(
        item:  vscode.CompletionItem,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem> {

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (item as any).data as ItemData | undefined;
        if (!data || token.isCancellationRequested) { return item; }

        // data.offset is already in virtual-file space — pass it directly.
        const details = getJsLanguageService().getCompletionDetails(data.name, data.offset, data.source);
        if (!details || token.isCancellationRequested) { return item; }

        const displayText = details.displayParts?.map(p => p.text).join('') ?? '';
        const docsText    = details.documentation?.map(p => p.text).join('') ?? '';
        const tagsText    = details.tags?.map(tag => {
            const body = tag.text?.map(p => p.text).join('') ?? '';
            return body ? `*@${tag.name}* — ${body}` : `*@${tag.name}*`;
        }).join('\n\n') ?? '';

        if (displayText) { item.detail = displayText; }

        if (docsText || tagsText) {
            const md = new vscode.MarkdownString('', true);
            md.isTrusted = true;
            if (docsText) { md.appendMarkdown(docsText); }
            if (docsText && tagsText) { md.appendMarkdown('\n\n'); }
            if (tagsText) { md.appendMarkdown(tagsText); }
            item.documentation = md;
        }

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