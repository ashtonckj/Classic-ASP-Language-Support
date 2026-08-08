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
import { getZone } from '../utils/zoneUtils';

/**
 * Given the text before the cursor, find the call the cursor is inside and which
 * argument (0-based) it is on. Scans forward so string literals are skipped —
 * a `(`, `)` or `,` inside "…" is data, not call syntax. Returns null when the
 * cursor is not inside an argument list.
 */
export function findActiveCall(textBefore: string): { openParenCol: number; activeParam: number } | null {
    const parenStack: number[] = [];
    const commaCounts: number[] = [];
    let inStr = false;

    for (let i = 0; i < textBefore.length; i++) {
        const ch = textBefore[i];
        if (inStr) {
            if (ch === '"') {
                if (textBefore[i + 1] === '"') { i++; continue; } // "" escaped quote
                inStr = false;
            }
            continue;
        }
        if (ch === '"')      { inStr = true; }
        else if (ch === '(') { parenStack.push(i); commaCounts.push(0); }
        else if (ch === ')') { parenStack.pop(); commaCounts.pop(); }
        else if (ch === ',' && parenStack.length > 0) { commaCounts[commaCounts.length - 1]++; }
    }

    if (parenStack.length === 0) { return null; }
    return { openParenCol: parenStack[parenStack.length - 1], activeParam: commaCounts[commaCounts.length - 1] };
}

export class AspSignatureHelpProvider implements vscode.SignatureHelpProvider {

    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token:   vscode.CancellationToken,
        _context:  vscode.SignatureHelpContext
    ): vscode.ProviderResult<vscode.SignatureHelp> {

        const fullText = document.getText();
        const offset  = document.offsetAt(position);

        // Only inside ASP blocks (both <% %> and <script language="vbscript"> zones)
        if (getZone(fullText, offset) !== 'asp') { return null; }

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        const call = findActiveCall(textBefore);
        if (!call) { return null; }
        const { openParenCol, activeParam } = call;

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