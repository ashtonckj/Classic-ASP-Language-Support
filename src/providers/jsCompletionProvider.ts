/**
 * jsCompletionProvider.ts  (providers/)
 *
 * Real TypeScript Language Service completions for <script> blocks.
 *
 * Fixes vs previous version:
 *   • item.data used instead of WeakMap<CompletionItem, ItemData> — VS Code
 *     can clone/serialize CompletionItem objects across the extension host
 *     boundary, which causes WeakMap lookups to silently return undefined in
 *     resolveCompletionItem, losing all detail/documentation.
 *   • Trigger characters reduced to just '.' and '(' — registering every
 *     letter caused provideCompletionItems to fire on every keystroke even
 *     inside string literals/comments.  VS Code's built-in word-based filter
 *     handles the rest once an initial list is returned with isIncomplete:false.
 *   • Preselects the first entry so TS completions rank above VS Code's
 *     generic word-based completions.
 *   • sortText prefix '0' pushes TS items to the top of the list.
 *   • resolveCompletionItem formats documentation as markdown with a fenced
 *     code block for the type signature.
 *   • Passes includeCompletionsWithInsertText so method snippets work.
 */

import * as vscode from 'vscode';
import {
    buildVirtualJsContent,
    getJsLanguageService,
    isInJsZone,
    tsKindToVsKind,
} from '../utils/jsUtils';

interface ItemData { name: string; offset: number; source?: string }

export class JsCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        if (!isInJsZone(document, position)) { return undefined; }

        const offset  = document.offsetAt(position);
        const content = document.getText();
        const { virtualContent, isInScript } = buildVirtualJsContent(content, offset);
        if (!isInScript || token.isCancellationRequested) { return undefined; }

        const lastChar    = offset > 0 ? virtualContent[offset - 1] : '';
        const triggerChar = lastChar === '.' ? '.' : undefined;

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        const completions = svc.getCompletions(offset, triggerChar);
        if (!completions || token.isCancellationRequested) { return undefined; }

        const items = completions.entries.map(entry => {
            const item      = new vscode.CompletionItem(entry.name, tsKindToVsKind(entry.kind));

            // Prefix sortText with '0' so TS completions always appear above
            // VS Code's generic word-based completions.
            item.sortText   = '0' + (entry.sortText ?? entry.name);
            item.filterText = entry.name;

            if (entry.insertText) {
                item.insertText = entry.isSnippet
                    ? new vscode.SnippetString(entry.insertText)
                    : entry.insertText;
            }

            // Commit characters — pressing '(' after a function suggestion
            // confirms it and immediately opens the parameter list.
            if (item.kind === vscode.CompletionItemKind.Function ||
                item.kind === vscode.CompletionItemKind.Method) {
                item.commitCharacters = ['('];
            }

            // Store resolution data on the item so it survives VS Code's
            // internal serialize/deserialize cycle before resolveCompletionItem
            // is called.  The 'data' field exists at runtime but is not exposed
            // in older @types/vscode declarations, so we go through `any`.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (item as any).data = { name: entry.name, offset, source: entry.source } satisfies ItemData;

            return item;
        });

        // isIncomplete: false — tell VS Code this is the complete list so it
        // doesn't keep re-requesting and merging with word completions.
        return new vscode.CompletionList(items, false);
    }

    resolveCompletionItem(
        item:  vscode.CompletionItem,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem> {

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (item as any).data as ItemData | undefined;
        if (!data || token.isCancellationRequested) { return item; }

        const details = getJsLanguageService().getCompletionDetails(
            data.name, data.offset, data.source
        );
        if (!details || token.isCancellationRequested) { return item; }

        // Build the type signature line (e.g. "(method) console.log(...): void")
        const displayText = details.displayParts?.map(p => p.text).join('') ?? '';

        // Build the documentation — JSDoc paragraphs, plain text
        const docsText = details.documentation?.map(p => p.text).join('') ?? '';

        // Build JSDoc @param / @returns tags if present
        const tagsText = details.tags?.map(tag => {
            const tagName = tag.name;
            const tagText = tag.text?.map(p => p.text).join('') ?? '';
            return tagText ? `*@${tagName}* — ${tagText}` : `*@${tagName}*`;
        }).join('\n\n') ?? '';

        if (displayText) {
            item.detail = displayText;
        }

        if (docsText || tagsText) {
            const md = new vscode.MarkdownString('', true);
            md.isTrusted = true;
            if (docsText) { md.appendMarkdown(docsText); }
            if (docsText && tagsText) { md.appendMarkdown('\n\n'); }
            if (tagsText) { md.appendMarkdown(tagsText); }
            item.documentation = md;
        }

        return item;
    }
}