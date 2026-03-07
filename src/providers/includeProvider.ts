import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FileSymbols {
    variables:    { name: string; line: number; filePath: string }[];
    constants:    { name: string; value: string; line: number; filePath: string }[];
    functions:    {
        name: string;
        kind: 'Function' | 'Sub';
        params: string;
        paramNames: string[];
        line: number;
        endLine: number;
        filePath: string;
    }[];
    comVariables: { name: string; progId: string; line: number; filePath: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol extraction
// Parses a block of ASP/VBScript text and returns all declared symbols
// (variables, constants, functions/subs, COM objects) tagged with their
// source file path and line number.
// ─────────────────────────────────────────────────────────────────────────────

export function extractSymbols(text: string, filePath: string): FileSymbols {
    const result: FileSymbols = {
        variables:    [],
        constants:    [],
        functions:    [],
        comVariables: [],
    };

    // Strip HTML comments so <!--METADATA ... --> blocks don't produce false symbols.
    // Non-newline characters are replaced with spaces to preserve line numbers.
    const strippedText = text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
    const lines = strippedText.split('\n');

    lines.forEach((line, lineIndex) => {
        // Skip full-line VBScript comments
        if (/^\s*'/.test(line)) return;

        // Strip string literals and inline comments so SQL / string content
        // inside quotes is never mistaken for code.
        const lineNoComment = line.replace(
            /(['"])(?:(?!\1).)*\1|'.*$/g,
            (m) => m.startsWith("'") ? '' : (m[0] + m[0])
        );

        // Dim / ReDim / Public / Private
        const dimMatch = lineNoComment.match(/^\s*(?:Dim|ReDim|Public|Private)\s+([\w,\s]+?)\s*(?:'|$)/i);
        if (dimMatch) {
            dimMatch[1].split(',').map((s: string) => s.trim()).filter(Boolean).forEach(name => {
                result.variables.push({ name, line: lineIndex, filePath });
            });
        }

        // Implicit assignment (undeclared variables, no Option Explicit)
        const implicitMatch = lineNoComment.match(/^\s*([a-zA-Z_]\w*)\s*=/i);
        if (implicitMatch) {
            const name = implicitMatch[1];
            const nameLower = name.toLowerCase();
            const skipWords = new Set([
                'dim','redim','set','const','if','for','while','do',
                'function','sub','class','select','with','on','option',
            ]);
            if (!skipWords.has(nameLower) && !result.variables.some(v => v.name.toLowerCase() === nameLower)) {
                result.variables.push({ name, line: lineIndex, filePath });
            }
        }

        // Const
        const constMatch = lineNoComment.match(/^\s*(?:Public\s+|Private\s+)?Const\s+(\w+)\s*=\s*(.+?)\s*(?:'.*)?$/i);
        if (constMatch) {
            result.constants.push({
                name:  constMatch[1],
                value: constMatch[2].trim(),
                line:  lineIndex,
                filePath,
            });
        }

        // Function / Sub (parentheses optional in VBScript)
        const funcMatch = lineNoComment.match(/^\s*(?:Public\s+|Private\s+)?(Function|Sub)\s+(\w+)\s*(?:\(([^)]*)\))?/i);
        if (funcMatch) {
            const rawParams  = funcMatch[3] ? funcMatch[3].trim() : '';
            const paramNames = rawParams.length > 0
                ? rawParams.split(',').map((p: string) =>
                    p.trim().replace(/^(?:ByVal|ByRef)\s+/i, '').replace(/\(\)$/, '').trim()
                  ).filter(Boolean)
                : [];
            result.functions.push({
                name:       funcMatch[2],
                kind:       funcMatch[1] as 'Function' | 'Sub',
                params:     rawParams,
                paramNames,
                line:       lineIndex,
                endLine:    -1,
                filePath,
            });
        }

        // Set x = [Server.]CreateObject("...")
        const setMatch = lineNoComment.match(/\bSet\s+(\w+)\s*=\s*(?:Server\.)?CreateObject\s*\(\s*["']([^"']+)["']\s*\)/i);
        if (setMatch) {
            result.comVariables.push({
                name:   setMatch[1],
                progId: setMatch[2].toLowerCase(),
                line:   lineIndex,
                filePath,
            });
        }
    });

    // Second pass — pair each Function/Sub with its End Function/End Sub line
    const openStack: number[] = [];
    lines.forEach((line, lineIndex) => {
        if (/^\s*(?:Public\s+|Private\s+)?(Function|Sub)\s+/i.test(line)) {
            const fnIndex = result.functions.findIndex(f => f.line === lineIndex);
            if (fnIndex !== -1) openStack.push(fnIndex);
        }
        if (/^\s*End\s+(Function|Sub)\b/i.test(line) && openStack.length > 0) {
            result.functions[openStack.pop()!].endLine = lineIndex;
        }
    });

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Include path resolution
// Returns the resolved absolute paths of all #include directives in the text.
// Supports file="..." (relative to current doc) and virtual="..." (workspace root).
// ─────────────────────────────────────────────────────────────────────────────

export function resolveIncludePaths(documentText: string, documentPath: string): string[] {
    const resolved: string[] = [];
    const docDir        = path.dirname(documentPath);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;
    const pattern       = /<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']+)["']\s*-->/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(documentText)) !== null) {
        const includeType = match[1].toLowerCase();
        const includePath = match[2];
        const fullPath    = includeType === 'virtual'
            ? path.join(workspaceRoot, includePath.replace(/^\//, ''))
            : path.resolve(docDir, includePath);

        if (fs.existsSync(fullPath)) resolved.push(fullPath);
    }

    return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol collection
// Merges symbols from the current document and all its #include'd files.
// ─────────────────────────────────────────────────────────────────────────────

export function collectAllSymbols(document: vscode.TextDocument): FileSymbols {
    const docText  = document.getText();
    const docPath  = document.uri.fsPath;
    const combined = extractSymbols(docText, docPath);

    for (const incPath of resolveIncludePaths(docText, docPath)) {
        try {
            const incSymbols = extractSymbols(fs.readFileSync(incPath, 'utf8'), incPath);
            combined.variables    .push(...incSymbols.variables);
            combined.constants    .push(...incSymbols.constants);
            combined.functions    .push(...incSymbols.functions);
            combined.comVariables .push(...incSymbols.comVariables);
        } catch {
            // Skip unreadable files silently
        }
    }

    return combined;
}

// ─────────────────────────────────────────────────────────────────────────────
// IncludePathCompletionProvider
// Suggests files and folders inside the quotes of #include directives.
// ─────────────────────────────────────────────────────────────────────────────

export class IncludePathCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);
        const includeMatch = textBefore.match(/<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']*)$/i);
        if (!includeMatch) return new vscode.CompletionList([], false);

        const includeType   = includeMatch[1].toLowerCase();
        const typedSoFar    = includeMatch[2];
        const docDir        = path.dirname(document.uri.fsPath);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;
        const baseDir       = includeType === 'virtual' ? workspaceRoot : docDir;

        // Split typed path into the directory prefix and the current segment
        const normalised   = typedSoFar.replace(/\\/g, '/');
        const lastSlash    = normalised.lastIndexOf('/');
        const typedDirPart = lastSlash >= 0 ? normalised.slice(0, lastSlash + 1) : '';
        const typedSegment = lastSlash >= 0 ? normalised.slice(lastSlash + 1)    : normalised;
        const searchDir    = path.resolve(baseDir, typedDirPart.replace(/\//g, path.sep));

        // Replace only the current segment so the typed directory prefix is never duplicated
        const replaceStart = new vscode.Position(position.line, position.character - typedSegment.length);
        const replaceRange = new vscode.Range(replaceStart, position);

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(searchDir, { withFileTypes: true });
        } catch {
            return new vscode.CompletionList([], true);
        }

        const items: vscode.CompletionItem[] = [];

        for (const entry of entries.filter(e => !e.name.startsWith('.'))) {
            const isDir  = entry.isDirectory();
            const isFile = entry.isFile();
            if (!isDir && !isFile) continue;

            const item = new vscode.CompletionItem(
                entry.name,
                isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
            );
            item.insertText = isDir ? entry.name + '/' : entry.name;
            item.filterText = entry.name;
            item.range      = replaceRange;
            item.detail     = isDir ? 'Directory' : 'Include file';
            item.sortText   = (isDir ? '0_' : '1_') + entry.name.toLowerCase();

            // Re-trigger after folder selection so the next level appears immediately
            if (isDir) item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };

            items.push(item);
        }

        // isIncomplete: true keeps the provider live on every keystroke
        return new vscode.CompletionList(items, true);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AspDefinitionProvider
// Handles F12 / Ctrl+Click for VBScript functions, subs, variables, constants,
// and COM object variables — across the current file and all #include'd files.
//
// HTML attribute links (href, src, etc.) are handled separately in linkProvider.ts.
// The guard below ensures those attribute values never fall through to symbol lookup.
// ─────────────────────────────────────────────────────────────────────────────

export class AspDefinitionProvider implements vscode.DefinitionProvider {

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Definition> {

        const lineText = document.lineAt(position.line).text;
        const docDir   = path.dirname(document.uri.fsPath);

        // Guard: if the cursor is inside an HTML file-link attribute value,
        // bail out immediately — linkProvider.ts owns those, and we must not
        // accidentally match the filename as a VBScript symbol (e.g. href="test.css"
        // matching a JS function named "test").
        if (isCursorInHtmlFileLinkAttribute(lineText, position.character)) {
            const resolved = resolveHtmlAttributeFilePath(lineText, position.character, docDir);
            if (resolved && fs.existsSync(resolved)) {
                return new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0));
            }
            return null;
        }

        // VBScript symbol lookup
        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const word    = document.getText(wordRange).toLowerCase();
        const symbols = collectAllSymbols(document);

        for (const fn of symbols.functions) {
            if (fn.name.toLowerCase() === word)
                return new vscode.Location(vscode.Uri.file(fn.filePath), new vscode.Position(fn.line, 0));
        }
        for (const v of symbols.variables) {
            if (v.name.toLowerCase() === word)
                return new vscode.Location(vscode.Uri.file(v.filePath), new vscode.Position(v.line, 0));
        }
        for (const c of symbols.constants) {
            if (c.name.toLowerCase() === word)
                return new vscode.Location(vscode.Uri.file(c.filePath), new vscode.Position(c.line, 0));
        }
        for (const cv of symbols.comVariables) {
            if (cv.name.toLowerCase() === word)
                return new vscode.Location(vscode.Uri.file(cv.filePath), new vscode.Position(cv.line, 0));
        }

        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (also used by linkProvider.ts)
// Exported so linkProvider.ts can reuse the same attribute detection logic
// without duplicating it.
// ─────────────────────────────────────────────────────────────────────────────

/** Attributes whose values are treated as local file paths. */
export const FILE_LINK_ATTRIBUTES = ['href', 'src', 'action', 'data-src'];

const HTML_ATTR_PATTERN = new RegExp(
    `\\b(${FILE_LINK_ATTRIBUTES.join('|')})\\s*=\\s*["']([^"']+)["']`,
    'gi'
);

/** True for values that are clearly not local files (URLs, anchors, mailto, etc.) */
export function isExternalPath(value: string): boolean {
    return /^(https?:\/\/|\/\/|mailto:|tel:|#|javascript:)/i.test(value);
}

/**
 * Returns true if the cursor character position falls inside a file-link
 * HTML attribute value on the given line.
 */
export function isCursorInHtmlFileLinkAttribute(lineText: string, character: number): boolean {
    HTML_ATTR_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HTML_ATTR_PATTERN.exec(lineText)) !== null) {
        const valueOffset = m[0].indexOf(m[2]);
        const valueStart  = m.index + valueOffset;
        const valueEnd    = valueStart + m[2].length;
        if (character >= valueStart && character <= valueEnd) return true;
    }
    return false;
}

/**
 * If the cursor is inside a file-link attribute value, returns the resolved
 * absolute path. Returns null for external/non-file values or no match.
 */
export function resolveHtmlAttributeFilePath(
    lineText: string,
    character: number,
    docDir: string
): string | null {
    HTML_ATTR_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HTML_ATTR_PATTERN.exec(lineText)) !== null) {
        const attrValue   = m[2];
        const valueOffset = m[0].indexOf(attrValue);
        const valueStart  = m.index + valueOffset;
        const valueEnd    = valueStart + attrValue.length;
        if (character >= valueStart && character <= valueEnd) {
            if (isExternalPath(attrValue)) return null;
            return path.resolve(docDir, attrValue);
        }
    }
    return null;
}