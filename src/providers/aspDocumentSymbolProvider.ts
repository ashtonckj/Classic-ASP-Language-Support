/**
 * aspDocumentSymbolProvider.ts
 *
 * Provides document symbols for the VS Code Outline panel and breadcrumb bar.
 * Shows Functions, Subs, Classes, and top-level Constants/Variables declared
 * in the current .asp file (not from #include'd files — those are separate docs).
 *
 * Symbols are derived from the same extractSymbols() pass used by completions,
 * hover, and semantic tokens so behaviour is always consistent.
 */

import * as vscode from 'vscode';
import { extractSymbols } from './includeProvider';

export class AspDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

    provideDocumentSymbols(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentSymbol[]> {

        if (document.languageId !== 'asp') { return []; }

        const text    = document.getText();
        const docPath = document.uri.fsPath;
        const symbols = extractSymbols(text, docPath);

        const result: vscode.DocumentSymbol[] = [];

        // ── Functions and Subs ────────────────────────────────────────────────
        for (const fn of symbols.functions) {
            const startLine = Math.max(0, Math.min(fn.line, document.lineCount - 1));
            const endLine   = fn.endLine !== -1
                ? Math.min(fn.endLine, document.lineCount - 1)
                : startLine;

            const startPos  = new vscode.Position(startLine, 0);
            const endPos    = document.lineAt(endLine).range.end;
            const range     = new vscode.Range(startPos, endPos);

            // selectionRange highlights just the name on the definition line
            const defLine   = document.lineAt(startLine).text;
            const nameIdx   = defLine.toLowerCase().indexOf(fn.name.toLowerCase());
            const selStart  = nameIdx >= 0 ? new vscode.Position(startLine, nameIdx) : startPos;
            const selEnd    = nameIdx >= 0
                ? new vscode.Position(startLine, nameIdx + fn.name.length)
                : startPos;

            const kind   = fn.kind === 'Function'
                ? vscode.SymbolKind.Function
                : vscode.SymbolKind.Method;

            const detail = fn.params ? `(${fn.params})` : '()';

            const sym = new vscode.DocumentSymbol(
                fn.name,
                detail,
                kind,
                range,
                new vscode.Range(selStart, selEnd)
            );

            result.push(sym);
        }

        // ── Constants ─────────────────────────────────────────────────────────
        for (const c of symbols.constants) {
            const line    = Math.max(0, Math.min(c.line, document.lineCount - 1));
            const lineEnd = document.lineAt(line).range.end;
            const range   = new vscode.Range(new vscode.Position(line, 0), lineEnd);

            const defText = document.lineAt(line).text;
            const nameIdx = defText.toLowerCase().indexOf(c.name.toLowerCase());
            const selStart = nameIdx >= 0 ? new vscode.Position(line, nameIdx) : range.start;
            const selEnd   = nameIdx >= 0
                ? new vscode.Position(line, nameIdx + c.name.length)
                : range.start;

            result.push(new vscode.DocumentSymbol(
                c.name,
                `= ${c.value}`,
                vscode.SymbolKind.Constant,
                range,
                new vscode.Range(selStart, selEnd)
            ));
        }

        // ── COM object variables (Set x = Server.CreateObject) ────────────────
        for (const cv of symbols.comVariables) {
            const line    = Math.max(0, Math.min(cv.line, document.lineCount - 1));
            const lineEnd = document.lineAt(line).range.end;
            const range   = new vscode.Range(new vscode.Position(line, 0), lineEnd);

            const defText = document.lineAt(line).text;
            const nameIdx = defText.toLowerCase().indexOf(cv.name.toLowerCase());
            const selStart = nameIdx >= 0 ? new vscode.Position(line, nameIdx) : range.start;
            const selEnd   = nameIdx >= 0
                ? new vscode.Position(line, nameIdx + cv.name.length)
                : range.start;

            result.push(new vscode.DocumentSymbol(
                cv.name,
                cv.progId,
                vscode.SymbolKind.Variable,
                range,
                new vscode.Range(selStart, selEnd)
            ));
        }

        // Sort all symbols by line number so the outline appears in source order
        result.sort((a, b) => a.range.start.line - b.range.start.line);

        return result;
    }
}