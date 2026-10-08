/**
 * aspSignatureHelpProvider.ts
 *
 * Provides parameter hints (signature help) for user-defined VBScript
 * functions and subs, and for VBScript's built-in functions (Mid, InStr,
 * Replace, …), when the user types `(` or `,` after a known function name.
 * The parser says which procedure the name means, so a local array `items(`
 * is not taken for a Function Items elsewhere, and `Me.Add(` finds the
 * class's own Add.
 *
 * Shows the function signature and highlights the current parameter based on
 * how many commas appear before the cursor inside the argument list.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { aspCodeStartOnLine } from '../platform/documentHelper';
import { scanVbLine } from '../core/vbLexical';
import { BUILTIN_FUNCTION_DOCS, BuiltinSignature, builtinSignature } from '../constants/aspKeywords';
import { declarationsOf, resolveAt } from '../vbscript/references';
import type * as A from '../vbscript/ast';
import { PROCEDURE_WORD } from '../vbscript/symbols';
import { editorWorkspace } from './vbscriptWorkspace';
import { contextAt } from '../platform/documentState';

/** Parameter hints for a built-in function, from its doc. */
function builtinHelp(builtin: BuiltinSignature, activeParam: number): vscode.SignatureHelp {
    const signature = new vscode.SignatureInformation(builtin.label, new vscode.MarkdownString(builtin.documentation));
    signature.parameters = builtin.parameters.map(parameter =>
        new vscode.ParameterInformation(
            parameter.range,
            parameter.doc ? new vscode.MarkdownString(parameter.doc) : undefined,
        ));

    const help           = new vscode.SignatureHelp();
    help.signatures      = [signature];
    help.activeSignature = 0;
    help.activeParameter = Math.min(activeParam, Math.max(0, builtin.parameters.length - 1));
    return help;
}

/**
 * Given the text before the cursor, find the call the cursor is inside and which
 * argument (0-based) it is on. Scans forward so string literals are skipped —
 * a `(`, `)` or `,` inside "…" is data, not call syntax. A `'` outside a string
 * starts a comment that runs to end of line, so everything after it — including
 * a commented-out call — is not call syntax either. Returns null when the cursor
 * is not inside an argument list.
 *
 * `from` is where this line's VBScript begins; callers pass it so an apostrophe
 * in HTML sharing the line is not read as a comment marker.
 */
export function findActiveCall(
    textBefore: string,
    from: number = 0,
): { openParenCol: number; activeParam: number } | null {
    const scan = scanVbLine(textBefore, from);
    if (scan.codeEnd < textBefore.length) { return null; } // the caret is in a comment

    const parenStack: number[] = [];
    const commaCounts: number[] = [];
    let string = 0;

    for (let i = from; i < textBefore.length; i++) {
        const literal = scan.strings[string];
        if (literal && i === literal.start) { i = literal.end - 1; string++; continue; }
        const ch = textBefore[i];
        if (ch === '(') { parenStack.push(i); commaCounts.push(0); }
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

        // Only inside ASP blocks (both <% %> and <script language="vbscript"> zones)
        if (contextAt(document, position).zone !== 'asp') { return null; }

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        const call = findActiveCall(textBefore, aspCodeStartOnLine(lineText, position.character));
        if (!call) { return null; }
        const { openParenCol, activeParam } = call;

        // Extract the function name immediately before the `(`
        const beforeParen = textBefore.substring(0, openParenCol);
        const nameMatch   = beforeParen.match(/\b(\w+)\s*$/);
        if (!nameMatch) { return null; }

        const funcName = nameMatch[1].toLowerCase();
        const afterDot = /\.\s*\w+\s*$/.test(beforeParen);

        // What the parser says the name means. Only a procedure has parameters
        // to show; a variable of that name is an array being indexed.
        const nameOffset = document.offsetAt(new vscode.Position(position.line, nameMatch.index!));
        const resolved   = resolveAt(editorWorkspace(document), document.uri.fsPath, nameOffset, !(funcName in BUILTIN_FUNCTION_DOCS));
        const decls      = resolved ? declarationsOf(resolved.bound.binding, resolved.target) : [];
        const procedure  = decls.map(d => d.node).reverse().find((n): n is A.ProcedureStmt => n?.kind === 'Procedure');
        if (!procedure) {
            // A built-in, unless the page declares its own of that name. After a
            // dot it is a member of something else — `re.Replace(` on a RegExp
            // is not VBScript's Replace.
            const doc     = afterDot || resolved ? undefined : BUILTIN_FUNCTION_DOCS[funcName];
            const builtin = doc ? builtinSignature(doc) : undefined;
            return builtin ? builtinHelp(builtin, activeParam) : null;
        }
        const file = decls.find(d => d.node === procedure)!.file;
        const fn   = {
            kind:       PROCEDURE_WORD[procedure.procKind],
            name:       procedure.name.text,
            paramNames: procedure.params.map(p => p.name.text),
            filePath:   file,
        };

        // Build the signature label  e.g.  "MyFunc(name, value, flag)"
        const paramNames  = fn.paramNames.length > 0 ? fn.paramNames : [];
        const paramsLabel = paramNames.join(', ');
        const sigLabel    = `${fn.kind} ${fn.name}(${paramsLabel})`;

        const sig         = new vscode.SignatureInformation(sigLabel);
        sig.documentation = new vscode.MarkdownString(
            `*${fn.kind}* defined in \`${path.basename(fn.filePath)}\``
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