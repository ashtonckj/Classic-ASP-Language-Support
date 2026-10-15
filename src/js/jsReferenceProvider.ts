/**
 * jsReferenceProvider.ts  (js/)
 *
 * Find All References (Shift+F12) and occurrence highlighting for symbols inside
 * <script> blocks.
 *
 * These two ship together because they answer the same question — where else is
 * this symbol? — and because without them VS Code falls back to matching the
 * word as TEXT. That fallback highlights a `total` inside a string or a comment
 * as if it were the variable, and offers no references at all.
 *
 * Spans outside the document (the generated preamble, lib.dom.d.ts) are dropped;
 * see jsRange.
 */

import * as vscode from 'vscode';
import { askJs, jsOffsetAt, jsRange } from './jsDocument';

export class JsReferenceProvider implements vscode.ReferenceProvider {

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context:  vscode.ReferenceContext,
        token:    vscode.CancellationToken,
    ): Promise<vscode.Location[] | undefined> {

        const offset = jsOffsetAt(document, position);
        if (offset === undefined) { return undefined; }

        // ReferenceEntry does not say which hit is the declaration, so when the
        // caller does not want it, resolve it separately and skip that span.
        const [definitions, references] = await Promise.all([
            context.includeDeclaration ? [] : askJs(document, 'getDefinitions', [offset], token),
            askJs(document, 'getReferences', [offset], token),
        ]);
        const declarations = new Set((definitions ?? []).map(def => `${def.fileName}:${def.textSpan.start}`));

        const locations: vscode.Location[] = [];
        for (const ref of references ?? []) {
            if (declarations.has(`${ref.fileName}:${ref.textSpan.start}`)) { continue; }
            const range = jsRange(document, ref.fileName, ref.textSpan);
            if (range) { locations.push(new vscode.Location(document.uri, range)); }
        }

        return locations.length ? locations : undefined;
    }
}

export class JsDocumentHighlightProvider implements vscode.DocumentHighlightProvider {

    async provideDocumentHighlights(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken,
    ): Promise<vscode.DocumentHighlight[] | undefined> {

        const offset = jsOffsetAt(document, position);
        if (offset === undefined) { return undefined; }

        const highlights: vscode.DocumentHighlight[] = [];
        for (const perFile of await askJs(document, 'getDocumentHighlights', [offset], token) ?? []) {
            for (const hit of perFile.highlightSpans) {
                const range = jsRange(document, perFile.fileName, hit.textSpan);
                if (!range) { continue; }
                highlights.push(new vscode.DocumentHighlight(
                    range,
                    hit.kind === 'writtenReference'
                        ? vscode.DocumentHighlightKind.Write
                        : vscode.DocumentHighlightKind.Read,
                ));
            }
        }

        return highlights.length ? highlights : undefined;
    }
}
