/**
 * jsHoverProvider.ts  (js/)
 *
 * Hover info for symbols inside <script> blocks, laid out like VS Code's own
 * JavaScript hover: the signature in a typescript code block, then the docs.
 * Node.js declarations never show up, because jsUtils leaves out @types/node.
 */

import * as vscode from 'vscode';
import { askJs, jsDocMarkdown, jsOffsetAt, jsRange } from './jsDocument';
import { VIRTUAL_FILENAME } from './jsUtils';

export class JsHoverProvider implements vscode.HoverProvider {

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {

        const offset = jsOffsetAt(document, position);
        if (offset === undefined) { return undefined; }

        const info = await askJs(document, 'getQuickInfo', [offset], token);
        if (!info) { return undefined; }

        const displayText = info.displayParts?.map(p => p.text).join('') ?? '';
        const docs        = jsDocMarkdown(info.documentation, info.tags);

        if (!displayText && !docs) { return undefined; }

        // Format exactly like VS Code's built-in JS hover:
        //   ```typescript
        //   (method) console.log(message?: any, ...): void
        //   ```
        //   Documentation text here.
        const md = new vscode.MarkdownString('', true);
        if (displayText) { md.appendCodeblock(displayText, 'typescript'); }
        if (docs)        { md.appendMarkdown(docs); }

        const range = info.textSpan && jsRange(document, VIRTUAL_FILENAME, info.textSpan);
        return new vscode.Hover(md, range);
    }
}