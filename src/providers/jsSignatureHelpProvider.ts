/**
 * jsSignatureHelpProvider.ts  (providers/)
 *
 * Shows parameter hints (signature help) when the user types "(" or ","
 * inside a function call in a <script> block.
 *
 * Fixes vs previous version:
 *   • si.documentation and paramDoc are now wrapped in MarkdownString so
 *     JSDoc formatting (backticks, links, bold) renders correctly in the
 *     signature help tooltip — previously they were plain strings.
 *   • FIX: preambleLength is now applied — cursor offset is shifted INTO
 *     the virtual file before the TS query so signature help fires at the
 *     correct position when a preamble is present.
 *
 * Registered in extension.ts alongside AspSignatureHelpProvider so the two
 * never conflict — AspSignatureHelpProvider only fires inside ASP zones and
 * this one only fires inside JS zones.
 */

import * as vscode from 'vscode';
import { buildVirtualJsContent, getJsLanguageService } from '../utils/jsUtils';
import { getZone } from '../utils/zoneUtils';

export class JsSignatureHelpProvider implements vscode.SignatureHelpProvider {

    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SignatureHelp> {

        const fullText = document.getText();
        const offset  = document.offsetAt(position);
        const { virtualContent, isInScript, preambleLength } = buildVirtualJsContent(fullText, offset);

        if (getZone(fullText, offset) !== 'js') { return undefined; }
        if (!isInScript || token.isCancellationRequested) { return undefined; }

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        // FIX: shift cursor offset into virtual-file space (add preambleLength)
        const items = svc.getSignatureHelp(offset + preambleLength);
        if (!items || token.isCancellationRequested) { return undefined; }

        const help            = new vscode.SignatureHelp();
        help.activeSignature  = items.selectedItemIndex;
        help.activeParameter  = items.argumentIndex;

        help.signatures = items.items.map(sig => {
            // Reconstruct the full label from display parts
            const prefix = sig.prefixDisplayParts.map(p => p.text).join('');
            const sep    = sig.separatorDisplayParts.map(p => p.text).join('');
            const suffix = sig.suffixDisplayParts.map(p => p.text).join('');
            const params = sig.parameters
                .map(p => p.displayParts.map(q => q.text).join(''))
                .join(sep);
            const label  = prefix + params + suffix;

            const si = new vscode.SignatureInformation(label);

            // Wrap documentation in MarkdownString so JSDoc formatting renders
            const sigDocText = sig.documentation?.map(p => p.text).join('') ?? '';
            if (sigDocText) {
                const sigMd = new vscode.MarkdownString(sigDocText, true);
                sigMd.isTrusted = true;
                si.documentation = sigMd;
            }

            si.parameters = sig.parameters.map(p => {
                const paramLabel   = p.displayParts.map(q => q.text).join('');
                const paramDocText = p.documentation?.map(q => q.text).join('') ?? '';

                const paramDoc = paramDocText
                    ? (() => {
                        const md = new vscode.MarkdownString(paramDocText, true);
                        md.isTrusted = true;
                        return md;
                    })()
                    : undefined;

                return new vscode.ParameterInformation(paramLabel, paramDoc);
            });

            return si;
        });

        return help;
    }
}