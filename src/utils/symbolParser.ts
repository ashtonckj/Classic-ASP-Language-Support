/**
 * symbolParser.ts
 *
 * The VBScript symbol list: text in, declared symbols out. The symbols come
 * from the syntax tree in src/vbscript; this file keeps the shape every
 * feature consumes, plus two small helpers that still read raw lines.
 *
 * Deliberately imports NO vscode APIs, and neither does anything it imports:
 * the colouring and include workers run on threads with no vscode module.
 */

import { symbolsFromTree } from '../vbscript/symbols';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FileSymbols {
    // `implicit` marks a name that was never explicitly declared - a bare
    // assignment (no Option Explicit) or a For Each loop variable. VBScript
    // does NOT create a new local for those: inside a procedure they resolve to
    // the module-level variable of that name when one exists. Only an explicit
    // Dim/Const shadows it, so anything reasoning about scope must tell them
    // apart.
    variables:    { name: string; line: number; filePath: string; implicit?: boolean }[];
    constants:    { name: string; value: string; line: number; filePath: string }[];
    functions:    {
        name: string;
        kind: 'Function' | 'Sub' | 'Property';
        params: string;
        paramNames: string[];
        line: number;
        endLine: number;
        filePath: string;
    }[];
    comVariables: { name: string; progId: string; line: number; filePath: string }[];
    classes:      { name: string; line: number; endLine: number; filePath: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Line helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a Const statement declares, from the text after `Const`:
 * `A = 1, B = "x, y"` is two constants. A comma inside a string or brackets
 * belongs to the value.
 *
 * Reading only up to the first `=` made `Const A = 1, B = 2` one constant, A,
 * whose value was `1, B = 2` — and left B out of completion, hover and rename.
 */
export function parseConstDeclarators(text: string): { name: string; value: string }[] {
    const parts: string[] = [];
    let start = 0;
    let depth = 0;
    let inStr = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (inStr && text[i + 1] === '"') { i++; continue; } // "" escaped quote
            inStr = !inStr;
        } else if (!inStr) {
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; }
            else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
        }
    }
    parts.push(text.slice(start));

    const declarators: { name: string; value: string }[] = [];
    for (const part of parts) {
        const match = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/.exec(part);
        if (match) { declarators.push({ name: match[1], value: match[2] }); }
    }
    return declarators;
}

/**
 * True when the call opening at `openParen` runs to the end of the statement.
 *
 * Parentheses are matched rather than counted to the first `)`, because an
 * argument is regularly a call of its own —
 * `fso.OpenTextFile(Server.MapPath("/x"), 1)` — and quotes are skipped so a
 * bracket inside a SQL string or a path cannot close the call early.
 */
export function callIsWholeExpression(line: string, openParen: number): boolean {
    let depth = 0;
    let inString = false;

    for (let i = openParen; i < line.length; i++) {
        const ch = line[i];

        if (inString) {
            // "" is an escaped quote in VBScript, so it does not end the string.
            if (ch === '"') {
                if (line[i + 1] === '"') { i++; } else { inString = false; }
            }
            continue;
        }

        if (ch === '"') { inString = true; continue; }
        if (ch === '(') { depth++; continue; }
        if (ch === ')') {
            depth--;
            if (depth > 0) { continue; }
            // Only whitespace or a trailing comment may follow the call.
            return /^\s*('.*)?$/.test(line.slice(i + 1));
        }
    }

    return false;   // unbalanced — the statement continues on another line
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every symbol a page declares, read from its VBScript syntax tree (see
 * src/vbscript). Unlike the line scanner it replaced, the tree knows a one-line
 * `If … Then x = 1`, a second `<% %>` block on a line and `<% Option Explicit %>`,
 * and never reads HTML attributes such as `onclick="…"` as assignments.
 */
export function extractSymbols(text: string, filePath: string): FileSymbols {
    return symbolsFromTree(text, filePath);
}
