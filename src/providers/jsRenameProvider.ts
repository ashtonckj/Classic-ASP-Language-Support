/**
 * jsRenameProvider.ts  (providers/)
 *
 * Rename Symbol (F2) for names inside <script> blocks.
 *
 * Scope is the point of this provider, so it is worth being explicit about what
 * it will and will not touch.
 *
 * A rename here covers THIS document only. The virtual file the language service
 * sees is assembled from one page: every <script> block in it, plus a generated
 * preamble. So a JS symbol's scope really is the page, and renaming it cannot
 * reach another file — which is the honest answer for client-side script.
 *
 * Two cases are refused rather than half-done:
 *
 *   * Names the language service says cannot be renamed — a DOM member such as
 *     `getElementById`, a keyword, a literal. TypeScript decides this, and it is
 *     right to: renaming `getElementById` in one page would just break the call.
 *
 *   * Names whose declaration lives in the generated preamble. Those are the
 *     cross-frame names (a function that actually lives on the parent page) and
 *     the values projected out of <% %> blocks. Renaming the uses in this page
 *     would leave the real declaration — in another file, or in VBScript —
 *     untouched, and silently break the page. The user is told instead.
 */

import * as vscode from 'vscode';
import {
    buildVirtualJsContent, getJsLanguageService, toDocumentSpan, VIRTUAL_FILENAME,
} from '../utils/jsUtils';
import { getZone } from '../utils/zoneUtils';

interface Ready {
    svc:            ReturnType<typeof getJsLanguageService>;
    virtualOffset:  number;
    preambleLength: number;
}

function prepare(
    document: vscode.TextDocument,
    position: vscode.Position,
): Ready | undefined {
    const fullText = document.getText();
    const offset   = document.offsetAt(position);
    if (getZone(fullText, offset) !== 'js') { return undefined; }

    const { virtualContent, isInScript, preambleLength } =
        buildVirtualJsContent(fullText, offset);
    if (!isInScript) { return undefined; }

    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);
    return { svc, virtualOffset: offset + preambleLength, preambleLength };
}

export class JsRenameProvider implements vscode.RenameProvider {

    /**
     * Decides up front whether F2 should open at all, so the user finds out
     * before typing a new name rather than after.
     */
    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.Range> {

        const ready = prepare(document, position);
        if (!ready || token.isCancellationRequested) { return undefined; }

        const info = ready.svc.getRenameInfo(ready.virtualOffset);
        if (!info || !info.canRename) {
            // TypeScript's own explanation is better than anything invented here.
            throw new Error(
                (info && 'localizedErrorMessage' in info && info.localizedErrorMessage)
                || 'This element cannot be renamed.',
            );
        }

        const span = toDocumentSpan(VIRTUAL_FILENAME, info.triggerSpan, ready.preambleLength);
        if (!span) {
            throw new Error('This name is generated, not part of the page, so it cannot be renamed.');
        }

        return new vscode.Range(
            document.positionAt(span.start),
            document.positionAt(span.end),
        );
    }

    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName:  string,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.WorkspaceEdit> {

        const ready = prepare(document, position);
        if (!ready || token.isCancellationRequested) { return undefined; }

        const locations = ready.svc.findRenameLocations(ready.virtualOffset);
        if (!locations.length) { return undefined; }

        const edit = new vscode.WorkspaceEdit();
        let inDocument = 0;

        for (const loc of locations) {
            const span = toDocumentSpan(loc.fileName, loc.textSpan, ready.preambleLength);
            if (!span) {
                // A location this rename would have to change but cannot reach.
                // Renaming only part of a symbol's uses is worse than refusing.
                throw new Error(
                    'This name is declared outside this page — on a parent page, or in a '
                    + '<% %> block — so renaming it here would change the calls but not the '
                    + 'declaration, and break the page.',
                );
            }
            edit.replace(
                document.uri,
                new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
                newName,
            );
            inDocument++;
        }

        return inDocument ? edit : undefined;
    }
}
