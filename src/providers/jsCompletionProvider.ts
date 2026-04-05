/**
 * jsCompletionProvider.ts  (providers/)
 *
 * TypeScript Language Service completions for <script> blocks.
 *
 * Resolution data is stored on item.data (cast through `any` since older
 * @types/vscode versions don't declare this field publicly) rather than a
 * WeakMap, so it survives VS Code's internal serialize/deserialize cycle
 * between provideCompletionItems and resolveCompletionItem.
 *
 * Trigger characters registered in extension.ts: '.', '(', '[', ' '
 *
 * isIncomplete strategy:
 *   • After a trigger character ('.', '(', '[') the list is always full and
 *     final — VS Code's word-based prefix filter handles narrowing, so we
 *     return isIncomplete:false.
 *   • When triggered mid-word (no trigger char, or after a space that starts
 *     a new expression context) we return isIncomplete:true so VS Code
 *     re-requests on every keystroke until the prefix is >= 2 characters,
 *     at which point the built-in filter is fast enough to take over.
 *
 *   This fixes the previous behaviour where isIncomplete was always false,
 *   meaning that after typing a fresh identifier VS Code would use only the
 *   stale list from the last '.' trigger and miss newly visible globals.
 */

import * as vscode from 'vscode';
import {
    buildVirtualJsContent,
    getJsLanguageService,
    isInJsZone,
    tsKindToVsKind,
} from '../utils/jsUtils';

interface ItemData {
    name:           string;
    offset:         number;
    source?:        string;
    /** True when the entry kind is Function or Method — used in resolveCompletionItem
     *  to decide whether to inject a call-snippet. */
    isFunctionLike: boolean;
}

/** Characters that signal we are starting a fresh expression context. */
const FRESH_CONTEXT_CHARS = new Set([' ', '\t', '\n', ';', '{', '}', '(', ',', '[', '=', '!', '&', '|', '+', '-', '*', '/', '%', '?', ':']);

export class JsCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document:        vscode.TextDocument,
        position:        vscode.Position,
        token:           vscode.CancellationToken,
        context:         vscode.CompletionContext,
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        if (!isInJsZone(document, position)) { return undefined; }

        const offset  = document.offsetAt(position);
        const content = document.getText();
        const { virtualContent, isInScript } = buildVirtualJsContent(content, offset);
        if (!isInScript || token.isCancellationRequested) { return undefined; }

        // ── Determine trigger character ──────────────────────────────────────
        // Prefer the explicit trigger VS Code gives us; fall back to inspecting
        // the character that precedes the cursor in case VS Code invoked us
        // via explicit Ctrl+Space rather than auto-trigger.
        const explicitTrigger = context.triggerCharacter;
        const prevChar        = offset > 0 ? virtualContent[offset - 1] : '';
        const triggerChar     = explicitTrigger ?? (prevChar === '.' ? '.' : undefined);

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        const completions = svc.getCompletions(offset, triggerChar);
        if (!completions || token.isCancellationRequested) { return undefined; }

        const items = completions.entries.map(entry => {
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
                // Keep commitCharacters so typing '(' still commits — the
                // snippet insertText is only applied on Tab/Enter via resolve.
                item.commitCharacters = ['('];
            }

            const isFunctionLike = item.kind === vscode.CompletionItemKind.Function
                                 || item.kind === vscode.CompletionItemKind.Method;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (item as any).data = { name: entry.name, offset, source: entry.source, isFunctionLike } satisfies ItemData;

            return item;
        });

        // ── isIncomplete decision ────────────────────────────────────────────
        // After '.' or '[' the list is member-scoped and complete — VS Code's
        // built-in prefix filter can narrow it without a re-request.
        // In a fresh expression context (space, open-paren, etc.) we mark
        // incomplete so VS Code re-requests as the user continues typing,
        // ensuring globals added after the last trigger are always visible.
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
        // Only applies to functions/methods, and only when the TS service has
        // not already provided its own insertText (e.g. for destructuring
        // completions the service supplies a custom snippet we must not clobber).
        //
        // We inspect the displayParts the service just returned to detect
        // whether the function has any parameters:
        //   • Parts contain a 'parameterName' or 'punctuation' '...' → has params
        //   • displayParts go straight from '(' to ')' with nothing between → no params
        //
        // Results:
        //   has params  →  name($0)     cursor lands inside the parens
        //   no params   →  name()$0     cursor lands after the parens
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