/**
 * jsHoverProvider.ts  (providers/)
 *
 * Hover info for symbols inside <script> blocks, laid out like VS Code's own
 * JavaScript hover: the signature in a typescript code block, then the docs.
 * Node.js declarations never show up, because jsUtils leaves out @types/node.
 *
 * TypeScript answers in the virtual file, which starts with a preamble, so the
 * caret offset goes in shifted by preambleLength and the span comes back
 * shifted the other way before it becomes a Range.
 */

import * as vscode from 'vscode';
import { prepareJsQuery } from '../utils/jsUtils';

export class JsHoverProvider implements vscode.HoverProvider {

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {

        const query = prepareJsQuery(document.getText(), document.offsetAt(position));
        if (!query || token.isCancellationRequested) { return undefined; }
        const { svc, virtualOffset, preambleLength } = query;

        const info = svc.getQuickInfo(virtualOffset);
        if (!info || token.isCancellationRequested) { return undefined; }

        const displayText = info.displayParts?.map(p => p.text).join('') ?? '';
        const docsText    = info.documentation?.map(p => p.text).join('') ?? '';
        const tagsText    = info.tags?.map(tag => {
            const name    = tag.name;
            const tagBody = tag.text?.map(p => p.text).join('') ?? '';
            return tagBody ? `*@${name}* — ${tagBody}` : `*@${name}*`;
        }).join('\n\n') ?? '';

        if (!displayText && !docsText) { return undefined; }

        // Format exactly like VS Code's built-in JS hover:
        //   ```typescript
        //   (method) console.log(message?: any, ...): void
        //   ```
        //   Documentation text here.
        const md = new vscode.MarkdownString('', true);
        md.isTrusted = true;
        if (displayText) { md.appendCodeblock(displayText, 'typescript'); }
        if (docsText)    { md.appendMarkdown(docsText); }
        if (tagsText)    { md.appendMarkdown('\n\n' + tagsText); }

        let range: vscode.Range | undefined;
        if (info.textSpan) {
            // Back out of the virtual file, past the preamble.
            const spanStart = info.textSpan.start - preambleLength;
            const spanEnd   = spanStart + info.textSpan.length;
            if (spanStart >= 0) {
                range = new vscode.Range(
                    document.positionAt(spanStart),
                    document.positionAt(spanEnd)
                );
            }
        }

        return new vscode.Hover(md, range);
    }
}