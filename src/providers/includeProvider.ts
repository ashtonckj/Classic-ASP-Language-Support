import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Symbols extracted from a single file (the current doc or any include file)
// ─────────────────────────────────────────────────────────────────────────────
export interface FileSymbols {
    /** Variables from Dim / ReDim / Public / Private */
    variables: { name: string; line: number; filePath: string }[];
    /** Constants from Const */
    constants: { name: string; value: string; line: number; filePath: string }[];
    /** Functions and Subs.
     *  startLine / endLine used to scope parameter highlighting to the function body only.
     *  paramNames is the parsed list of individual parameter identifiers. */
    functions: {
        name: string;
        kind: 'Function' | 'Sub';
        params: string;
        paramNames: string[];
        line: number;
        endLine: number;   // line of matching End Function / End Sub (-1 if not found)
        filePath: string;
    }[];
    /** COM object variables from Set x = CreateObject(...) */
    comVariables: { name: string; progId: string; line: number; filePath: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Extracts all symbols from a block of text, tagged with their source filePath
// and line number so Go To Definition / semantic highlighting can use them.
// ─────────────────────────────────────────────────────────────────────────────
export function extractSymbols(text: string, filePath: string): FileSymbols {
    const result: FileSymbols = {
        variables:    [],
        constants:    [],
        functions:    [],
        comVariables: [],
    };

    const lines = text.split('\n');

    // First pass — collect all symbols
    lines.forEach((line, lineIndex) => {

        // ── Dim / ReDim / Public / Private ───────────────────────────────────
        const dimMatch = line.match(/^\s*(?:Dim|ReDim|Public|Private)\s+([\w,\s]+?)(?:\s*(?:'|=|$))/i);
        if (dimMatch) {
            const names = dimMatch[1].split(',').map((s: string) => s.trim()).filter(Boolean);
            for (const name of names) {
                if (name) result.variables.push({ name, line: lineIndex, filePath });
            }
        }

        // ── Const ─────────────────────────────────────────────────────────────
        const constMatch = line.match(/^\s*(?:Public\s+|Private\s+)?Const\s+(\w+)\s*=\s*(.+?)(?:\s*'|$)/i);
        if (constMatch) {
            result.constants.push({
                name:     constMatch[1],
                value:    constMatch[2].trim(),
                line:     lineIndex,
                filePath,
            });
        }

        // ── Function / Sub ────────────────────────────────────────────────────
        // Parentheses are optional in VBScript — Sub ConnectDb is valid without ()
        const funcMatch = line.match(/^\s*(?:Public\s+|Private\s+)?(Function|Sub)\s+(\w+)\s*(?:\(([^)]*)\))?/i);
        if (funcMatch) {
            // Parse individual parameter names — strips ByVal/ByRef and array () markers
            const rawParams  = funcMatch[3] ? funcMatch[3].trim() : '';
            const paramNames = rawParams.length > 0
                ? rawParams
                    .split(',')
                    .map((p: string) => p.trim().replace(/^(?:ByVal|ByRef)\s+/i, '').replace(/\(\)$/, '').trim())
                    .filter(Boolean)
                : [];

            result.functions.push({
                name:       funcMatch[2],
                kind:       funcMatch[1] as 'Function' | 'Sub',
                params:     rawParams,
                paramNames,
                line:       lineIndex,
                endLine:    -1,   // filled in second pass below
                filePath,
            });
        }

        // ── Set x = [Server.]CreateObject("...") ─────────────────────────────
        const setMatch = line.match(/\bSet\s+(\w+)\s*=\s*(?:Server\.)?CreateObject\s*\(\s*["']([^"']+)["']\s*\)/i);
        if (setMatch) {
            result.comVariables.push({
                name:     setMatch[1],
                progId:   setMatch[2].toLowerCase(),
                line:     lineIndex,
                filePath,
            });
        }
    });

    // Second pass — match End Function / End Sub to their opening declaration
    // Simple stack handles nested functions (rare in VBScript but valid inside Classes)
    const openStack: number[] = [];
    lines.forEach((line, lineIndex) => {
        if (/^\s*(?:Public\s+|Private\s+)?(Function|Sub)\s+/i.test(line)) {
            const fnIndex = result.functions.findIndex(f => f.line === lineIndex);
            if (fnIndex !== -1) openStack.push(fnIndex);
        }
        if (/^\s*End\s+(Function|Sub)\b/i.test(line) && openStack.length > 0) {
            const fnIndex = openStack.pop()!;
            result.functions[fnIndex].endLine = lineIndex;
        }
    });

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finds all #include directives in a document and returns their resolved paths.
// Supports both:
//   <!--#include file="relative/path.asp"-->
//   <!--#include virtual="/absolute/path.asp"-->
//
// For "virtual" paths we resolve relative to the workspace root.
// For "file" paths we resolve relative to the current document's directory.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveIncludePaths(documentText: string, documentPath: string): string[] {
    const resolved: string[] = [];
    const docDir        = path.dirname(documentPath);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;

    const pattern = /<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']+)["']\s*-->/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(documentText)) !== null) {
        const includeType = match[1].toLowerCase();
        const includePath = match[2];

        let fullPath: string;
        if (includeType === 'virtual') {
            fullPath = path.join(workspaceRoot, includePath.replace(/^\//, ''));
        } else {
            fullPath = path.resolve(docDir, includePath);
        }

        if (fs.existsSync(fullPath)) {
            resolved.push(fullPath);
        }
    }

    return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads all include files referenced in the document and merges their symbols
// with the current document's own symbols.
// Returns a combined FileSymbols object for use in completions / definitions.
// ─────────────────────────────────────────────────────────────────────────────
export function collectAllSymbols(document: vscode.TextDocument): FileSymbols {
    const docText = document.getText();
    const docPath = document.uri.fsPath;

    const combined = extractSymbols(docText, docPath);

    const includePaths = resolveIncludePaths(docText, docPath);
    for (const incPath of includePaths) {
        try {
            const incText    = fs.readFileSync(incPath, 'utf8');
            const incSymbols = extractSymbols(incText, incPath);

            combined.variables    .push(...incSymbols.variables);
            combined.constants    .push(...incSymbols.constants);
            combined.functions    .push(...incSymbols.functions);
            combined.comVariables .push(...incSymbols.comVariables);
        } catch {
            // Silently skip unreadable files
        }
    }

    return combined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Completion provider for #include file/virtual path suggestions.
// ─────────────────────────────────────────────────────────────────────────────
export class IncludePathCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.CompletionItem[]> {

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        const includeMatch = textBefore.match(/<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']*)$/i);
        if (!includeMatch) return [];

        const includeType   = includeMatch[1].toLowerCase();
        const typedSoFar    = includeMatch[2];
        const docDir        = path.dirname(document.uri.fsPath);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;

        const baseDir   = includeType === 'virtual' ? workspaceRoot : docDir;
        const typedDir  = path.dirname(typedSoFar);
        const searchDir = path.resolve(baseDir, typedDir === '.' ? '' : typedDir);

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(searchDir, { withFileTypes: true });
        } catch {
            return [];
        }

        const items: vscode.CompletionItem[] = [];

        for (const entry of entries) {
            const isDir     = entry.isDirectory();
            const isAspFile = entry.isFile() && /\.(asp|inc)$/i.test(entry.name);
            if (!isDir && !isAspFile) continue;

            const completionPath = typedDir === '.'
                ? entry.name
                : typedDir + '/' + entry.name;

            const item = new vscode.CompletionItem(
                entry.name,
                isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
            );

            item.insertText = completionPath.replace(/\\/g, '/');
            item.detail     = isDir ? 'Directory' : 'Include file';

            if (isDir) {
                item.insertText = item.insertText + '/';
                item.command    = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
            }

            items.push(item);
        }

        return items;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Go To Definition provider for Functions, Subs, and variables.
// Works across the current document AND all included files.
// ─────────────────────────────────────────────────────────────────────────────
export class AspDefinitionProvider implements vscode.DefinitionProvider {

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Definition> {

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const word    = document.getText(wordRange).toLowerCase();
        const symbols = collectAllSymbols(document);

        for (const fn of symbols.functions) {
            if (fn.name.toLowerCase() === word) {
                return new vscode.Location(vscode.Uri.file(fn.filePath), new vscode.Position(fn.line, 0));
            }
        }
        for (const v of symbols.variables) {
            if (v.name.toLowerCase() === word) {
                return new vscode.Location(vscode.Uri.file(v.filePath), new vscode.Position(v.line, 0));
            }
        }
        for (const c of symbols.constants) {
            if (c.name.toLowerCase() === word) {
                return new vscode.Location(vscode.Uri.file(c.filePath), new vscode.Position(c.line, 0));
            }
        }
        for (const cv of symbols.comVariables) {
            if (cv.name.toLowerCase() === word) {
                return new vscode.Location(vscode.Uri.file(cv.filePath), new vscode.Position(cv.line, 0));
            }
        }

        return null;
    }
}