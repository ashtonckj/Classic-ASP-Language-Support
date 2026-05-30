/**
 * jsHoverProvider.ts  (providers/)
 *
 * Hover info for symbols inside <script> blocks.
 *
 * Fixes vs previous version:
 *   • Documentation is now rendered as a proper MarkdownString matching
 *     VS Code's built-in JS hover format:
 *       ```typescript
 *       (method) console.log(...): void
 *       ```
 *       Plain text documentation paragraph.
 *   • Strips Node.js-specific content by virtue of jsUtils now blocking
 *     @types/node via types:[]
 *   • FIX: preambleLength is now applied — offset is shifted INTO the virtual
 *     file before the TS query, and the returned textSpan is shifted BACK before
 *     being converted to a VS Code Range. Without this, the hover highlight and
 *     tooltip appeared at the wrong position whenever the preamble was non-empty.
 */

import * as vscode from 'vscode';
import { buildVirtualJsContent, getJsLanguageService } from '../utils/jsUtils';
import { getZone } from '../utils/zoneUtils';

export class JsHoverProvider implements vscode.HoverProvider {

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {

        const fullText = document.getText();
        const offset  = document.offsetAt(position);
        const { virtualContent, isInScript, preambleLength } = buildVirtualJsContent(fullText, offset);

        if (getZone(fullText, offset) !== 'js') { return undefined; }
        if (!isInScript || token.isCancellationRequested) { return undefined; }

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        // FIX: shift cursor offset into virtual-file space (add preambleLength)
        const info = svc.getQuickInfo(offset + preambleLength);
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
            // FIX: shift span positions BACK from virtual-file space (subtract preambleLength)
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