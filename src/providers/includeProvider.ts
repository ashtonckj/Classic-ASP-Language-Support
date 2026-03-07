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

    // Strip HTML comments (<!-- ... -->) before splitting into lines.
    // This prevents content inside comments — especially <!--METADATA ... -->
    // blocks whose attribute lines look like  TYPE="TypeLib"  NAME="..."  etc. —
    // from being mistaken for VBScript implicit-variable assignments.
    // Each non-newline character is replaced with a space to preserve line numbers.
    const strippedText = text.replace(/<!--[\s\S]*?-->/g, match =>
        match.replace(/[^\n]/g, ' ')
    );

    const lines = strippedText.split('\n');

    // First pass — collect all symbols
    lines.forEach((line, lineIndex) => {

        // ── Skip comment lines entirely ───────────────────────────────────────
        // VBScript comments start with ' (after optional whitespace).
        // Nothing on a comment line should ever be registered as a symbol.
        if (/^\s*'/.test(line)) return;

        // ── Strip string literal contents and inline comments ─────────────────
        // We need to match only real VBScript code, not text inside strings.
        // Replace every quoted string with empty quotes ("" or ''), then strip
        // anything after a bare ' (which is now guaranteed to be a comment).
        //
        // The callback returns:
        //   m[0]+m[0]  → empty string literal ("" or '')  for quoted strings
        //   ''         → nothing                           for ' comments
        //
        // This prevents SQL identifiers inside string values (ROW_NUMBER, EXEC
        // usp_ProcessOrders, DENSE_RANK, etc.) from ever matching the patterns below.
        const lineNoComment = line.replace(
            /(['"])(?:(?!\1).)*\1|'.*$/g,
            (m) => m.startsWith("'") ? '' : (m[0] + m[0])
        );

        // ── Dim / ReDim / Public / Private ───────────────────────────────────
        // Match everything after the keyword up to an optional comment or end-of-line.
        const dimMatch = lineNoComment.match(/^\s*(?:Dim|ReDim|Public|Private)\s+([\w,\s]+?)\s*(?:'|$)/i);
        if (dimMatch) {
            const names = dimMatch[1].split(',').map((s: string) => s.trim()).filter(Boolean);
            for (const name of names) {
                if (name) result.variables.push({ name, line: lineIndex, filePath });
            }
        }

        // ── Implicit variables — plain assignment without Dim ─────────────────
        // VBScript allows undeclared variables when Option Explicit is NOT used.
        // We detect  "word ="  at the start of a line (skipping Set, For, Const lines
        // which have their own handlers) and register the LHS as a variable so the
        // semantic provider can colour its usages throughout the file.
        // We skip names already registered to avoid duplicates.
        // Uses lineNoComment so SQL inside strings is never mistaken for an assignment.
        const implicitMatch = lineNoComment.match(/^\s*([a-zA-Z_]\w*)\s*=/i);
        if (implicitMatch) {
            const name = implicitMatch[1];
            const nameLower = name.toLowerCase();
            // Skip keywords and already-handled constructs
            const skipWords = new Set([
                'dim','redim','set','const','if','for','while','do',
                'function','sub','class','select','with','on','option',
            ]);
            if (!skipWords.has(nameLower) && !result.variables.some(v => v.name.toLowerCase() === nameLower)) {
                result.variables.push({ name, line: lineIndex, filePath });
            }
        }

        // ── Const ─────────────────────────────────────────────────────────────
        // Greedy value capture (.+) so the full value is captured before an optional comment.
        // The trailing /i flag keeps case-insensitive matching for 'Const' keyword.
        const constMatch = lineNoComment.match(/^\s*(?:Public\s+|Private\s+)?Const\s+(\w+)\s*=\s*(.+?)\s*(?:'.*)?$/i);
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
        const funcMatch = lineNoComment.match(/^\s*(?:Public\s+|Private\s+)?(Function|Sub)\s+(\w+)\s*(?:\(([^)]*)\))?/i);
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
        const setMatch = lineNoComment.match(/\bSet\s+(\w+)\s*=\s*(?:Server\.)?CreateObject\s*\(\s*["']([^"']+)["']\s*\)/i);
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
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        const includeMatch = textBefore.match(/<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']*)$/i);
        if (!includeMatch) { return new vscode.CompletionList([], false); }

        const includeType   = includeMatch[1].toLowerCase();
        const typedSoFar    = includeMatch[2];          // e.g. '../../sub/part'
        const docDir        = path.dirname(document.uri.fsPath);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;

        const baseDir = includeType === 'virtual' ? workspaceRoot : docDir;

        // Split what the user typed into the directory prefix and the current segment.
        // Normalise to forward-slashes first so path splitting works on Windows too.
        const normalised   = typedSoFar.replace(/\\/g, '/');
        const lastSlash    = normalised.lastIndexOf('/');
        const typedDirPart = lastSlash >= 0 ? normalised.slice(0, lastSlash + 1) : ''; // e.g. '../../sub/'
        const typedSegment = lastSlash >= 0 ? normalised.slice(lastSlash + 1)    : normalised; // e.g. 'part'

        // path.resolve on Windows can mishandle forward-slash relative paths.
        // Convert the relative part to the OS separator before resolving.
        const relativeDir = typedDirPart.replace(/\//g, path.sep);
        const searchDir   = path.resolve(baseDir, relativeDir);

        // The range each item will REPLACE is only the current segment (after the
        // last slash), so the already-typed directory prefix is never duplicated.
        const replaceStart = new vscode.Position(position.line, position.character - typedSegment.length);
        const replaceRange = new vscode.Range(replaceStart, position);

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(searchDir, { withFileTypes: true });
        } catch {
            // Directory doesn't exist or can't be read — return incomplete so
            // VS Code re-invokes us on the next keystroke rather than caching []
            return new vscode.CompletionList([], true);
        }

        // Skip hidden dot-files / dot-folders
        const visible = entries.filter(e => !e.name.startsWith('.'));

        const items: vscode.CompletionItem[] = [];

        for (const entry of visible) {
            const isDir     = entry.isDirectory();
            // Show all files — the user decides what to include; we should not
            // silently hide files just because of their extension.
            const isFile = entry.isFile();
            if (!isDir && !isFile) { continue; }

            const item = new vscode.CompletionItem(
                entry.name,
                isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
            );

            // insertText is ONLY the segment name — never the full path prefix.
            // replaceRange tells VS Code exactly which text to swap out, preventing
            // the typed directory traversal from being duplicated on accept.
            item.insertText = isDir ? entry.name + '/' : entry.name;
            item.filterText = entry.name;   // keeps the list alive as user types letters
            item.range      = replaceRange;
            item.detail     = isDir ? 'Directory' : 'Include file';
            item.sortText   = (isDir ? '0_' : '1_') + entry.name.toLowerCase();

            if (isDir) {
                // Re-trigger after the slash so the next directory level appears immediately
                item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
            }

            items.push(item);
        }

        // isIncomplete: true forces VS Code to re-invoke the provider on every
        // keystroke instead of caching and filtering the stale list itself.
        // This ensures suggestions always reflect the current typed path segment.
        return new vscode.CompletionList(items, true);
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