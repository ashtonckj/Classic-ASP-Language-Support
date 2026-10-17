/**
 * aspFoldingProvider.ts  (asp/)
 *
 * Folding for an ASP page: every VBScript block the parser pairs (Sub,
 * Function, Class, If, For, Do, While, Select, With), however the page is
 * indented, plus the indentation folding VS Code gives a file with no
 * provider. A language with a folding provider loses that indentation
 * folding, so it is worked out here too, the same way, for the markup,
 * <script> and <style>.
 */

import * as vscode from 'vscode';
import { analysedPage } from './vbscriptWorkspace';

/** VS Code's own rule: a line folds to the last line indented deeper below it; blank lines go with the block. */
export function indentationRanges(lines: string[], tabSize: number): Array<{ start: number; end: number }> {
    const indentOf = (text: string) => {
        let width = 0;
        for (const ch of text) {
            if (ch === ' ') { width++; } else if (ch === '\t') { width += tabSize - (width % tabSize); } else { return width; }
        }
        return -1; // blank
    };
    const ranges: Array<{ start: number; end: number }> = [];
    const open: Array<{ line: number; indent: number }> = [];
    let lastNonBlank = -1;
    for (let i = 0; i <= lines.length; i++) {
        const indent = i < lines.length ? indentOf(lines[i]) : 0;
        if (indent === -1) { continue; }
        while (open.length > 0 && open[open.length - 1].indent >= indent) {
            const opener = open.pop()!;
            if (lastNonBlank > opener.line) { ranges.push({ start: opener.line, end: lastNonBlank }); }
        }
        if (i < lines.length) { open.push({ line: i, indent }); lastNonBlank = i; }
    }
    return ranges;
}

export class AspFoldingRangeProvider implements vscode.FoldingRangeProvider {
    async provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.FoldingRange[] | undefined> {
        const version = document.version;
        const lines = document.getText().split(/\r?\n/);
        const tabSize = Number(vscode.workspace.getConfiguration('editor', document).get('tabSize')) || 4;
        const ranges = new Map<string, vscode.FoldingRange>();
        for (const { start, end } of indentationRanges(lines, tabSize)) { ranges.set(`${start}:${end}`, new vscode.FoldingRange(start, end)); }

        const page = await analysedPage(document, token);
        if (page && page.version === version && !token.isCancellationRequested) {
            for (const { opener, closer } of page.blocks.pairs) {
                // The closer stays in view, as `End If` does under a folded `If`.
                const start = document.positionAt(opener.start).line;
                const end = document.positionAt(closer.start).line - 1;
                if (end > start) { ranges.set(`${start}:${end}`, new vscode.FoldingRange(start, end)); }
            }
        }
        return [...ranges.values()];
    }
}
