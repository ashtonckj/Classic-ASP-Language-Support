/**
 * jsReferenceProvider.ts  (providers/)
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
 * see toDocumentSpan.
 */

import * as vscode from 'vscode';
import { prepareJsQuery, toDocumentSpan } from '../utils/jsUtils';

/** The service positioned on `position`, or undefined outside a <script> block. */
function prepare(document: vscode.TextDocument, position: vscode.Position) {
    return prepareJsQuery(document.getText(), document.offsetAt(position));
}

export class JsReferenceProvider implements vscode.ReferenceProvider {

    provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context:  vscode.ReferenceContext,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.Location[]> {

        const ready = prepare(document, position);
        if (!ready || token.isCancellationRequested) { return undefined; }

        // ReferenceEntry does not say which hit is the declaration, so when the
        // caller does not want it, resolve it separately and skip that span.
        const declarations = new Set<string>();
        if (!context.includeDeclaration) {
            for (const def of ready.svc.getDefinitions(ready.virtualOffset)) {
                declarations.add(`${def.fileName}:${def.textSpan.start}`);
            }
        }

        const locations: vscode.Location[] = [];
        for (const ref of ready.svc.getReferences(ready.virtualOffset)) {
            if (declarations.has(`${ref.fileName}:${ref.textSpan.start}`)) { continue; }
            const span = toDocumentSpan(ref.fileName, ref.textSpan, ready.preambleLength);
            if (!span) { continue; }
            locations.push(new vscode.Location(
                document.uri,
                new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
            ));
        }

        return locations.length ? locations : undefined;
    }
}

export class JsDocumentHighlightProvider implements vscode.DocumentHighlightProvider {

    provideDocumentHighlights(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.DocumentHighlight[]> {

        const ready = prepare(document, position);
        if (!ready || token.isCancellationRequested) { return undefined; }

        const highlights: vscode.DocumentHighlight[] = [];
        for (const perFile of ready.svc.getDocumentHighlights(ready.virtualOffset)) {
            for (const hit of perFile.highlightSpans) {
                const span = toDocumentSpan(perFile.fileName, hit.textSpan, ready.preambleLength);
                if (!span) { continue; }
                highlights.push(new vscode.DocumentHighlight(
                    new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
                    hit.kind === 'writtenReference'
                        ? vscode.DocumentHighlightKind.Write
                        : vscode.DocumentHighlightKind.Read,
                ));
            }
        }

        return highlights.length ? highlights : undefined;
    }
}
