import * as vscode from 'vscode';
import * as fs from 'fs';
import { collectAllSymbols, resolveIncludePaths } from './includeProvider';
import { getZone } from '../utils/zoneUtils';
import { VBSCRIPT_KEYWORDS_SET } from '../constants/aspKeywords';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// AspRenameProvider
//
// Implements F2 rename for VBScript functions, subs, variables, constants, and
// COM object variables — across the current file and all #include'd files.
//
// prepareRename:    validates the word under the cursor is a renameable symbol.
// provideRenameEdits: scans every relevant file and returns a WorkspaceEdit.
// ─────────────────────────────────────────────────────────────────────────────

export class AspRenameProvider implements vscode.RenameProvider {

    // ── prepareRename ─────────────────────────────────────────────────────────
    // Called before the rename input box appears. Return the current word range
    // so VS Code pre-fills it, or throw to show an error and abort.
    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) throw new Error('No symbol found at cursor position.');

        const word = document.getText(wordRange);
        const offset = document.offsetAt(position);
        const fullText = document.getText();

        // Only allow rename inside ASP blocks — renaming HTML tag names or CSS
        // identifiers is not something this provider handles.
        // getZone covers both <% %> blocks and <script language="vbscript"> blocks.
        if (getZone(fullText, offset) !== 'asp') {
            throw new Error('Rename is only supported for VBScript symbols inside ASP blocks.');
        }

        if (VBSCRIPT_KEYWORDS_SET.has(word.toLowerCase())) {
            throw new Error(`"${word}" is a VBScript keyword and cannot be renamed.`);
        }

        // Make sure it actually matches a known user-defined symbol.
        const symbols = collectAllSymbols(document);
        const wordLower = word.toLowerCase();
        const known =
            symbols.functions.some((s) => s.name.toLowerCase() === wordLower) ||
            symbols.variables.some((s) => s.name.toLowerCase() === wordLower) ||
            symbols.constants.some((s) => s.name.toLowerCase() === wordLower) ||
            symbols.comVariables.some(
                (s) => s.name.toLowerCase() === wordLower,
            );

        if (!known) {
            throw new Error(`"${word}" is not a recognised VBScript symbol.`);
        }

        return { range: wordRange, placeholder: word };
    }

    // ── provideRenameEdits ────────────────────────────────────────────────────
    // Called after the user confirms the new name. Returns a WorkspaceEdit
    // that replaces every occurrence of the old name in all relevant files.
    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string
    ): vscode.ProviderResult<vscode.WorkspaceEdit> {

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const oldName = document.getText(wordRange);
        const fullText = document.getText();
        const docPath = document.uri.fsPath;
        const edit = new vscode.WorkspaceEdit();

        // Validate the new name is a legal VBScript identifier.
        if (!/^[a-zA-Z_]\w*$/.test(newName)) {
            vscode.window.showErrorMessage(
                `"${newName}" is not a valid VBScript identifier. ` +
                `Names must start with a letter or underscore and contain only letters, digits, and underscores.`
            );
            return null;
        }

        if (VBSCRIPT_KEYWORDS_SET.has(newName.toLowerCase())) {
            vscode.window.showErrorMessage(`"${newName}" is a VBScript keyword and cannot be used as an identifier.`);
            return null;
        }

        // Build the set of files to search: current document + all its includes
        // + every other .asp / .inc file in the workspace that might reference
        // this symbol transitively (e.g. a page that includes the file where the
        // symbol is declared). resolveIncludePaths handles circular guards.
        const includedPaths = resolveIncludePaths(fullText, docPath);
        const includedSet = new Set<string>(
            [docPath, ...includedPaths].map((p) => p.toLowerCase()),
        );

        // Collect all .asp and .inc files in the workspace
        const workspaceFiles: { fsPath: string; getText: () => string }[] = [];
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            try {
                const found = findAspFiles(folder.uri.fsPath);
                for (const fp of found) {
                    if (!includedSet.has(fp.toLowerCase())) {
                        workspaceFiles.push({
                            fsPath: fp,
                            getText: () => {
                                try {
                                    return fs.readFileSync(fp, 'utf8');
                                } catch {
                                    return '';
                                }
                            },
                        });
                    }
                }
            } catch {
                /* skip unreadable folders */
            }
        }

        const filesToSearch: { fsPath: string; getText: () => string }[] = [
            { fsPath: docPath, getText: () => fullText },
            ...includedPaths.map((p) => ({
                fsPath: p,
                getText: () => {
                    try {
                        return fs.readFileSync(p, 'utf8');
                    } catch {
                        return '';
                    }
                },
            })),
            ...workspaceFiles,
        ];

        for (const file of filesToSearch) {
            const text = file.getText();
            if (!text) continue;

            const fileUri = vscode.Uri.file(file.fsPath);
            const ranges = findAllOccurrences(text, oldName);

            for (const { line, character } of ranges) {
                edit.replace(
                    fileUri,
                    new vscode.Range(
                        new vscode.Position(line, character),
                        new vscode.Position(line, character + oldName.length),
                    ),
                    newName,
                );
            }
        }

        return edit;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// findAspFiles
// Recursively walks a directory and returns all .asp and .inc file paths.
// Skips node_modules and hidden directories for performance.
// ─────────────────────────────────────────────────────────────────────────────

function findAspFiles(dir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findAspFiles(fullPath));
        } else if (entry.isFile() && /\.(asp|inc)$/i.test(entry.name)) {
            results.push(fullPath);
        }
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// findAllOccurrences
//
// Scans `text` for every occurrence of `name` that:
//   - is a whole word (word-boundary match)
//   - sits inside an ASP block (<% ... %>)
//   - is not inside a string literal ("...")
//   - is not part of a VBScript comment (' ...)
//
// VBScript is case-insensitive, so matching is case-insensitive.
// Returns line + character positions (0-based) of every match start.
// ─────────────────────────────────────────────────────────────────────────────

function findAllOccurrences(
    text: string,
    name: string
): { line: number; character: number }[] {

    const results: { line: number; character: number }[] = [];
    // \b word boundary + case-insensitive flag so "myFunc" matches "MyFunc"
    const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');

    // Build a per-character map of which offsets are inside an ASP block.
    // We replicate the lightweight bitmap approach from aspSemanticProvider
    // rather than calling isInsideAspBlock() in a loop (which would be O(n²)).
    const aspMap = buildAspMap(text);

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const offset = match.index;

        // Must be inside an ASP block
        if (!aspMap[offset]) continue;

        // Must not be inside a string literal or comment on the same line.
        // We check the slice of the line up to this token's column.
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1; // 0 when on line 0
        const colInLine = offset - lineStart;
        const lineSlice = text.slice(lineStart, offset);

        if (isInStringOrComment(lineSlice)) continue;

        // Compute line number from offset for constructing vscode.Position
        const lineNumber = countNewlines(text, offset);
        results.push({ line: lineNumber, character: colInLine });
    }

    return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Escapes special regex characters in a literal string. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a Uint8Array where aspMap[i] === 1 means offset i is inside <% %>.
 *
 * Mirrors the line-by-line logic of isInsideVirtualAspBlock in zoneUtils.ts so that:
 *   - %> inside a VBScript comment line (') is NOT treated as a block close
 *   - %> inside a string literal ("...") is NOT treated as a block close
 */
function buildAspMap(text: string): Uint8Array {
    const map = new Uint8Array(text.length);
    let i = 0;
    let inAsp = false;

    while (i < text.length) {
        if (!inAsp) {
            const openIdx = text.indexOf('<%', i);
            if (openIdx === -1) break;

            // Mark the opening bracket
            map[openIdx] = 1; map[openIdx + 1] = 1;

            inAsp = true;
            i = openIdx + 2;
        } else {
            const lineEnd = text.indexOf('\n', i);
            const end = lineEnd === -1 ? text.length : lineEnd + 1;

            let j = i;
            let inStr = false;
            let found = false;

            while (j < end) {
                const ch = text[j];

                if (inStr) {
                    if (ch === '"') {
                        if (j + 1 < end && text[j + 1] === '"') {
                            map[j] = 1;
                            map[j + 1] = 1;
                            j += 2;
                            continue;
                        }
                        inStr = false;
                    }
                    map[j] = 1;
                    j++;
                    continue;
                }

                if (ch === '"') {
                    inStr = true;
                    map[j] = 1;
                    j++;
                    continue;
                }

                if (ch === "'") {
                    // VBScript comment — mark rest of line as inside ASP
                    while (j < end) {
                        map[j] = 1;
                        j++;
                    }
                    i = end;
                    found = true;
                    break;
                }

                if (ch === '%' && j + 1 < text.length && text[j + 1] === '>') {
                    const closeEnd = j + 2;
                    // Mark the closing bracket
                    map[j] = 1;
                    map[j + 1] = 1;
                    inAsp = false;
                    i = closeEnd;
                    found = true;
                    break;
                }

                map[j] = 1;
                j++;
            }

            if (!found) {
                // Mark rest of line as inside ASP
                while (i < end) {
                    map[i] = 1;
                    i++;
                }
            }
        }
    }

    return map;
}
/**
 * Returns true when `lineSlice` (the text from line start up to but not
 * including the token) indicates the token is inside a string literal or
 * after a VBScript comment marker.
 *
 * Logic:
 *   - Walk through the slice character by character.
 *   - Track whether we're inside a double-quoted string ("...").
 *     VBScript uses "" to escape a literal quote inside a string.
 *   - If we see a ' outside a string, the rest of the line is a comment.
 */
function isInStringOrComment(lineSlice: string): boolean {
    let inString = false;

    for (let i = 0; i < lineSlice.length; i++) {
        const ch = lineSlice[i];

        if (inString) {
            if (ch === '"') {
                // "" inside a string is an escaped quote — stay in string
                if (lineSlice[i + 1] === '"') {
                    i++;
                } else {
                    inString = false;
                }
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        // A lone ' outside a string opens a VBScript comment to end-of-line,
        // meaning the token (which comes after this slice) is inside a comment.
        if (ch === "'") return true;
    }

    // If inString is still true here the quote was never closed on this line,
    // which means the token sits inside the string literal.
    return inString;
}

/**
 * Counts the number of newline characters before `offset` in `text`.
 * Equivalent to the 0-based line number of that offset.
 * Avoiding document.positionAt() lets us work on raw strings from fs.readFileSync.
 */
function countNewlines(text: string, offset: number): number {
    let count = 0;
    for (let i = 0; i < offset; i++) {
        if (text[i] === '\n') count++;
    }
    return count;
}