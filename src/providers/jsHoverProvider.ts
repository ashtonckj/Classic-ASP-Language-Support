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
        const { virtualContent, isInScript } = buildVirtualJsContent(fullText, offset);

        if (getZone(fullText, offset) !== 'js') { return undefined; }
        if (!isInScript || token.isCancellationRequested) { return undefined; }

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        const info = svc.getQuickInfo(offset);
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
            range = new vscode.Range(
                document.positionAt(info.textSpan.start),
                document.positionAt(info.textSpan.start + info.textSpan.length)
            );
        }

        return new vscode.Hover(md, range);
    }
}