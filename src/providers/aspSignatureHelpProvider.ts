/**
 * aspSignatureHelpProvider.ts
 *
 * Provides parameter hints (signature help) for user-defined VBScript
 * functions and subs when the user types `(` or `,` after a known function name.
 *
 * Shows the function signature and highlights the current parameter based on
 * how many commas appear before the cursor inside the argument list.
 */

import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import { isInsideAspBlock } from '../utils/aspUtils';

export class AspSignatureHelpProvider implements vscode.SignatureHelpProvider {

    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token:   vscode.CancellationToken,
        _context:  vscode.SignatureHelpContext
    ): vscode.ProviderResult<vscode.SignatureHelp> {

        const content = document.getText();
        const offset  = document.offsetAt(position);

        // Only inside ASP blocks
        if (!isInsideAspBlock(content, offset)) { return null; }

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        // Find the function call that the cursor is currently inside.
        // Walk backwards from the cursor looking for an unmatched `(`.
        // Track depth so nested calls like Func(Other(x), y) work correctly.
        let depth        = 0;
        let openParenCol = -1;
        let activeParam  = 0;

        for (let i = textBefore.length - 1; i >= 0; i--) {
            const ch = textBefore[i];
            if (ch === ')') { depth++; continue; }
            if (ch === '(') {
                if (depth > 0) { depth--; continue; }
                openParenCol = i;
                break;
            }
            // Count commas at depth 0 to determine active parameter
            if (ch === ',' && depth === 0) { activeParam++; }
        }

        if (openParenCol < 0) { return null; }

        // Extract the function name immediately before the `(`
        const beforeParen = textBefore.substring(0, openParenCol);
        const nameMatch   = beforeParen.match(/\b(\w+)\s*$/);
        if (!nameMatch) { return null; }

        const funcName = nameMatch[1].toLowerCase();
        const symbols  = collectAllSymbols(document);

        const fn = symbols.functions.find(f => f.name.toLowerCase() === funcName);
        if (!fn) { return null; }

        // Build the signature label  e.g.  "MyFunc(name, value, flag)"
        const paramNames  = fn.paramNames.length > 0 ? fn.paramNames : [];
        const paramsLabel = paramNames.join(', ');
        const sigLabel    = `${fn.kind} ${fn.name}(${paramsLabel})`;

        const sig         = new vscode.SignatureInformation(sigLabel);
        sig.documentation = new vscode.MarkdownString(
            `*${fn.kind}* defined in \`${require('path').basename(fn.filePath)}\``
        );

        // Add each parameter as a ParameterInformation so VS Code can highlight it
        for (const param of paramNames) {
            sig.parameters.push(new vscode.ParameterInformation(param));
        }

        const help             = new vscode.SignatureHelp();
        help.signatures        = [sig];
        help.activeSignature   = 0;
        help.activeParameter   = Math.min(activeParam, Math.max(0, paramNames.length - 1));

        return help;
    }
}