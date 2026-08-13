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
import { indexOfWholeWord } from '../utils/documentHelper';

export class AspDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

    provideDocumentSymbols(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentSymbol[]> {

        if (document.languageId !== 'asp') { return []; }

        const fullText = document.getText();
        const docPath = document.uri.fsPath;
        const symbols = extractSymbols(fullText, docPath);

        const result: vscode.DocumentSymbol[] = [];

        // ── Class ranges, for nesting ─────────────────────────────────────────
        // A Class's range spans its whole body, so its members must go in that
        // symbol's `children`. Emitting them as siblings gave overlapping ranges
        // (which the DocumentSymbol contract forbids) and left the breadcrumb bar
        // unable to show `Cart > Add`.
        const classSymbols: { line: number; endLine: number; symbol: vscode.DocumentSymbol }[] = [];

        // Adds `sym` to the innermost Class whose body contains `line`, or to the
        // top level when it is not inside one.
        const place = (line: number, sym: vscode.DocumentSymbol): void => {
            let owner: { line: number; endLine: number; symbol: vscode.DocumentSymbol } | null = null;
            for (const c of classSymbols) {
                if (c.endLine >= 0 && c.line < line && line <= c.endLine && (!owner || c.line > owner.line)) {
                    owner = c;
                }
            }
            (owner ? owner.symbol.children : result).push(sym);
        };

        // ── Classes ───────────────────────────────────────────────────────────
        // Built first so members resolved below can be nested into them.
        for (const cls of symbols.classes) {
            const startLine = Math.max(0, Math.min(cls.line, document.lineCount - 1));
            const endLine   = cls.endLine !== -1
                ? Math.min(cls.endLine, document.lineCount - 1)
                : startLine;

            const range    = new vscode.Range(
                new vscode.Position(startLine, 0),
                document.lineAt(endLine).range.end,
            );

            const defLine  = document.lineAt(startLine).text;
            const nameIdx  = indexOfWholeWord(defLine, cls.name);
            const selStart = nameIdx >= 0 ? new vscode.Position(startLine, nameIdx) : range.start;
            const selEnd   = nameIdx >= 0
                ? new vscode.Position(startLine, nameIdx + cls.name.length)
                : range.start;

            const sym = new vscode.DocumentSymbol(
                cls.name,
                '',
                vscode.SymbolKind.Class,
                range,
                new vscode.Range(selStart, selEnd),
            );

            classSymbols.push({ line: startLine, endLine, symbol: sym });
            result.push(sym);
        }

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
            const nameIdx   = indexOfWholeWord(defLine, fn.name);
            const selStart  = nameIdx >= 0 ? new vscode.Position(startLine, nameIdx) : startPos;
            const selEnd    = nameIdx >= 0
                ? new vscode.Position(startLine, nameIdx + fn.name.length)
                : startPos;

            const kind   = fn.kind === 'Function' ? vscode.SymbolKind.Function
                : fn.kind === 'Property'          ? vscode.SymbolKind.Property
                : vscode.SymbolKind.Method;

            const detail = fn.kind === 'Property'
                ? (fn.params ? `(${fn.params})` : '')
                : (fn.params ? `(${fn.params})` : '()');

            const sym = new vscode.DocumentSymbol(
                fn.name,
                detail,
                kind,
                range,
                new vscode.Range(selStart, selEnd)
            );

            place(startLine, sym);
        }

        // ── Constants ─────────────────────────────────────────────────────────
        for (const c of symbols.constants) {
            const line    = Math.max(0, Math.min(c.line, document.lineCount - 1));
            const lineEnd = document.lineAt(line).range.end;
            const range   = new vscode.Range(new vscode.Position(line, 0), lineEnd);

            const defText = document.lineAt(line).text;
            const nameIdx = indexOfWholeWord(defText, c.name);
            const selStart = nameIdx >= 0 ? new vscode.Position(line, nameIdx) : range.start;
            const selEnd   = nameIdx >= 0
                ? new vscode.Position(line, nameIdx + c.name.length)
                : range.start;

            place(line, new vscode.DocumentSymbol(
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
            const nameIdx = indexOfWholeWord(defText, cv.name);
            const selStart = nameIdx >= 0 ? new vscode.Position(line, nameIdx) : range.start;
            const selEnd   = nameIdx >= 0
                ? new vscode.Position(line, nameIdx + cv.name.length)
                : range.start;

            place(line, new vscode.DocumentSymbol(
                cv.name,
                cv.progId,
                vscode.SymbolKind.Variable,
                range,
                new vscode.Range(selStart, selEnd)
            ));
        }

        // ── Variables (Dim) ───────────────────────────────────────────────────
        // Only those declared outside every Function/Sub/Property body — an
        // in-body local belongs to that routine, not the file outline, and without
        // Option Explicit the implicit-assignment pass would otherwise fill the
        // outline with every temporary the page assigns. A Class member is not a
        // local, so `Private items` still shows, nested under its Class.
        const bodies = symbols.functions.filter(f => f.endLine >= 0);
        const isLocal = (line: number) => bodies.some(f => f.line <= line && line <= f.endLine);
        const alreadyListed = new Set<string>([
            ...symbols.comVariables.map(cv => cv.name.toLowerCase()),
            ...symbols.constants.map(c => c.name.toLowerCase()),
        ]);

        for (const v of symbols.variables) {
            const key = v.name.toLowerCase();
            if (alreadyListed.has(key) || isLocal(v.line)) { continue; }
            alreadyListed.add(key);

            const line    = Math.max(0, Math.min(v.line, document.lineCount - 1));
            const lineEnd = document.lineAt(line).range.end;
            const range   = new vscode.Range(new vscode.Position(line, 0), lineEnd);

            const defText = document.lineAt(line).text;
            const nameIdx = indexOfWholeWord(defText, v.name);
            const selStart = nameIdx >= 0 ? new vscode.Position(line, nameIdx) : range.start;
            const selEnd   = nameIdx >= 0
                ? new vscode.Position(line, nameIdx + v.name.length)
                : range.start;

            place(line, new vscode.DocumentSymbol(
                v.name,
                '',
                vscode.SymbolKind.Variable,
                range,
                new vscode.Range(selStart, selEnd)
            ));
        }

        // Sort every level by line number so the outline appears in source order
        const sortByLine = (list: vscode.DocumentSymbol[]): void => {
            list.sort((a, b) => a.range.start.line - b.range.start.line);
            for (const s of list) { sortByLine(s.children); }
        };
        sortByLine(result);

        return result;
    }
}