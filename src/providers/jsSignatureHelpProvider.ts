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
 *
 * Registered in extension.ts alongside AspSignatureHelpProvider so the two
 * never conflict — AspSignatureHelpProvider only fires inside ASP zones and
 * this one only fires inside JS zones.
 */

import * as vscode from 'vscode';
import {
    buildVirtualJsContent,
    getJsLanguageService,
    isInJsZone,
} from '../utils/jsUtils';

export class JsSignatureHelpProvider implements vscode.SignatureHelpProvider {

    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SignatureHelp> {

        if (!isInJsZone(document, position)) { return undefined; }

        const offset  = document.offsetAt(position);
        const content = document.getText();
        const { virtualContent, isInScript } = buildVirtualJsContent(content, offset);
        if (!isInScript || token.isCancellationRequested) { return undefined; }

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        const items = svc.getSignatureHelp(offset);
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

                // ParameterInformation also accepts MarkdownString for documentation
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