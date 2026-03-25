import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { COM_METHOD_RETURN_TYPES } from '../constants/comObjects';

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
// Virtual root resolution
// Returns the base directory to use when resolving virtual="..." includes.
//
// Priority:
//   1. aspLanguageSupport.virtualRoot setting (explicit user override)
//   2. First workspace folder root (common case — user opened VS Code at app root)
//   3. Directory of the current document (last resort fallback)
// ─────────────────────────────────────────────────────────────────────────────

export function getVirtualRoot(documentPath: string): string {
    const config      = vscode.workspace.getConfiguration('aspLanguageSupport');
    const userSetting = config.get<string>('virtualRoot', '').trim();

    if (userSetting) {
        // Expand a leading ~/ on macOS/Linux for convenience
        const expanded = userSetting.startsWith('~/')
            ? path.join(process.env.HOME ?? userSetting, userSetting.slice(2))
            : userSetting;
        return expanded;
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? path.dirname(documentPath);
}

// Tracks whether we have already shown the virtual root hint in this session
// so we don't spam the user on every file open.
let _virtualRootWarningShown = false;

/**
 * Shows a one-time information message when a virtual="..." include fails to
 * resolve and no explicit virtualRoot setting has been configured.
 */
function notifyVirtualRootUnresolved(includePath: string): void {
    const config      = vscode.workspace.getConfiguration('aspLanguageSupport');
    const userSetting = config.get<string>('virtualRoot', '').trim();

    // Only notify when the user hasn't already set a root
    if (userSetting || _virtualRootWarningShown) return;
    _virtualRootWarningShown = true;

    vscode.window.showInformationMessage(
        `Classic ASP: could not resolve virtual include "${includePath}". ` +
        `If your virtual root differs from the workspace folder, set ` +
        `"aspLanguageSupport.virtualRoot" in your settings.`,
        'Open Settings'
    ).then(choice => {
        if (choice === 'Open Settings') {
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'aspLanguageSupport.virtualRoot'
            );
        }
    });
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

    // Detect Option Explicit anywhere in the file (outside of string literals).
    // When present, VBScript requires all variables to be declared with Dim/Const,
    // so implicit assignment tracking would only add noise — loop counters, temp
    // vars, and typos would all surface as false symbol suggestions.
    const hasOptionExplicit = /^\s*Option\s+Explicit\b/im.test(strippedText);

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
        // Skipped entirely when Option Explicit is present — in that mode every
        // real variable must be Dim'd, so implicit assignments are either already
        // captured above or are typos/loop counters we don't want in suggestions.
        if (!hasOptionExplicit) {
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

        // Set x = [Server.]CreateObject("...") — must run on original line, not
        // lineNoComment, because the progId is inside a string literal.
        const setMatch = line.match(/\bSet\s+(\w+)\s*=\s*(?:Server\.)?CreateObject\s*\(\s*["']([^"']+)["']\s*\)/i);
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

    // Third pass — infer COM types from chained method calls.
    // Matches: Set x = someVar.Method(...)
    // Looks up someVar's progId from already-collected comVariables, then checks
    // COM_METHOD_RETURN_TYPES to see if that method returns a typed COM object.
    const comVarIndex = new Map(result.comVariables.map(cv => [cv.name.toLowerCase(), cv.progId]));
    lines.forEach((line, lineIndex) => {
        if (/^\s*'/.test(line)) return;

        const chainMatch = line.match(/^\s*Set\s+(\w+)\s*=\s*(\w+)\.(\w+)\s*\(/i);
        if (!chainMatch) return;

        const [, assignTo, sourceVar, methodName] = chainMatch;

        // Skip if already tracked via CreateObject
        if (comVarIndex.has(assignTo.toLowerCase())) return;

        const sourceProgId = comVarIndex.get(sourceVar.toLowerCase());
        if (!sourceProgId) return;

        const returnProgId = COM_METHOD_RETURN_TYPES[`${sourceProgId}.${methodName.toLowerCase()}`];
        if (!returnProgId) return;

        result.comVariables.push({ name: assignTo, progId: returnProgId, line: lineIndex, filePath });
        comVarIndex.set(assignTo.toLowerCase(), returnProgId);
    });

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Include path resolution
// Returns the resolved absolute paths of all #include directives in the text.
// Supports file="..." (relative to current doc) and virtual="..." (virtual root).
// ─────────────────────────────────────────────────────────────────────────────

// Resolves all #include paths from a single file's text — one level only.
function resolveDirectIncludes(documentText: string, documentPath: string): string[] {
    const resolved:    string[] = [];
    const docDir      = path.dirname(documentPath);
    const virtualRoot = getVirtualRoot(documentPath);
    const pattern     = /<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']+)["']\s*-->/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(documentText)) !== null) {
        const includeType = match[1].toLowerCase();
        const includePath = match[2];

        const fullPath = includeType === 'virtual'
            ? path.join(virtualRoot, includePath.replace(/^\//, ''))
            : path.resolve(docDir, includePath);

        if (fs.existsSync(fullPath)) {
            resolved.push(fullPath);
        } else if (includeType === 'virtual') {
            notifyVirtualRootUnresolved(includePath);
        }
    }

    return resolved;
}

// Recursively resolves all #include paths starting from a document.
// `visited` prevents infinite loops when files include each other circularly.
export function resolveIncludePaths(documentText: string, documentPath: string, visited: Set<string> = new Set()): string[] {
    const resolved: string[] = [];
    const normalised = documentPath.toLowerCase();

    if (visited.has(normalised)) return resolved;
    visited.add(normalised);

    for (const incPath of resolveDirectIncludes(documentText, documentPath)) {
        if (visited.has(incPath.toLowerCase())) continue;
        resolved.push(incPath);

        try {
            const incText = fs.readFileSync(incPath, 'utf8');
            resolved.push(...resolveIncludePaths(incText, incPath, visited));
        } catch {
            // Skip unreadable files silently
        }
    }

    return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol collection
// Merges symbols from the current document and all included files (all depths).
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

        const includeType = includeMatch[1].toLowerCase();
        const typedSoFar  = includeMatch[2];
        const docDir      = path.dirname(document.uri.fsPath);

        // Use the same resolution logic as resolveIncludePaths so completions
        // browse from the correct root for both file="..." and virtual="..."
        const baseDir = includeType === 'virtual'
            ? getVirtualRoot(document.uri.fsPath)
            : docDir;

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
// Shared helpers (also used by linkProvider.ts and aspHoverProvider.ts)
// These are now defined in ../utils/htmlLinkUtils.ts and re-exported here so
// that any existing import of these names from includeProvider continues to work.
// ─────────────────────────────────────────────────────────────────────────────
export { FILE_LINK_ATTRIBUTES, isExternalPath, isCursorInHtmlFileLinkAttribute } from '../utils/htmlLinkUtils';
// Re-export AspDefinitionProvider from its new dedicated file.
// Any existing import of AspDefinitionProvider from includeProvider continues to work.
export { AspDefinitionProvider } from './aspDefinitionProvider';