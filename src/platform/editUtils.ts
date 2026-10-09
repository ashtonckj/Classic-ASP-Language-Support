/**
 * editUtils.ts
 *
 * Turning formatted text back into TextEdits.
 *
 * Two things matter here:
 *   • Only the lines that actually moved may be replaced. Replacing the whole
 *     document marks every line as changed in the gutter/overview ruler and
 *     jumps the caret to the end of the file.
 *   • The edits must be written with the DOCUMENT's line endings. Prettier
 *     normalises its output (and the VBScript passes join on '\n'), so a
 *     CRLF-saved file would otherwise come back LF-only — which both converts
 *     the file's line endings and makes every single line differ, defeating the
 *     line-level diff above.
 */

import * as vscode from 'vscode';

/** The line-ending sequence a document is currently saved with. */
export function documentEol(document: vscode.TextDocument): string {
    return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/**
 * Resolves the line ending to write, from the `prettier.endOfLine` setting.
 * `auto` (the default) keeps the document's own line endings — the setting only
 * forces a conversion when the user explicitly picks one.
 */
export function resolveEol(setting: string, document: vscode.TextDocument): string {
    switch (setting) {
        case 'lf':   return '\n';
        case 'crlf': return '\r\n';
        case 'cr':   return '\r';
        default:     return documentEol(document);
    }
}

/** Normalises every line ending in `text` to '\n' so texts can be diffed line by line. */
export function toLf(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

/** Position of the very end of the document (last line, last character). */
function documentEnd(document: vscode.TextDocument): vscode.Position {
    const lastLine = Math.max(0, document.lineCount - 1);
    return new vscode.Position(lastLine, document.lineAt(lastLine).text.length);
}

/**
 * Returns line-level TextEdits instead of replacing the whole document, so only
 * the lines that really changed are touched. Ctrl+Z still undoes everything in
 * one step.
 *
 * `original` and `formatted` must both be '\n'-normalised (see toLf) — line
 * indices then line up with the document's own, whatever it is saved with — and
 * `eol` is the line ending the replacement text is written with.
 */
export function computeLineEdits(
    document:  vscode.TextDocument,
    original:  string,
    formatted: string,
    eol:       string,
): vscode.TextEdit[] {
    const originalLines  = original.split('\n');
    const formattedLines = formatted.split('\n');
    const edits: vscode.TextEdit[] = [];

    let i = 0;
    while (i < Math.max(originalLines.length, formattedLines.length)) {
        if (originalLines[i] === formattedLines[i]) { i++; continue; }

        let j = i + 1;
        while (
            j < Math.max(originalLines.length, formattedLines.length) &&
            originalLines[j] !== formattedLines[j]
        ) { j++; }

        const endLine  = Math.min(j, originalLines.length);
        const newText  = formattedLines.slice(i, j).join(eol);
        const startPos = new vscode.Position(i, 0);
        const endPos   = endLine < originalLines.length
            ? new vscode.Position(endLine, 0)
            : documentEnd(document);

        edits.push(vscode.TextEdit.replace(
            new vscode.Range(startPos, endPos),
            newText + (endLine < originalLines.length ? eol : '')
        ));
        i = j;
    }

    return edits;
}

/** A run of lines of `a` (aStart…aEnd) that becomes lines bStart…bEnd of `b`. */
export interface LineHunk {
    aStart: number;
    aEnd:   number;
    bStart: number;
    bEnd:   number;
}

/**
 * Past this many lines that differ in more than whitespace, alignLines gives
 * up. Its memory grows with the square of that count, and a page where formatting
 * changed that much is one to format whole.
 */
const MAX_ALIGNED_CHANGES = 2000;

/**
 * Lines of `a` paired with the lines of `b` they became, and what is left over
 * as hunks — every line whose text differs, including one that only moved.
 *
 * Lines pair up by their text without whitespace, which is what formatting
 * changes; a Myers diff on that finds the smallest set of lines that did more.
 * Undefined when there are more than MAX_ALIGNED_CHANGES of those.
 */
export function alignLines(a: string[], b: string[]): LineHunk[] | undefined {
    const key = (line: string) => line.trim().replace(/\s+/g, ' ');
    const ak = a.map(key);
    const bk = b.map(key);

    // Myers, keeping each round's furthest-reaching paths to walk back through.
    const n = ak.length, m = bk.length, max = n + m;
    const offset = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= Math.min(max, MAX_ALIGNED_CHANGES) && !found; d++) {
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        const next = v.slice();
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
                ? v[offset + k + 1]
                : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && ak[x] === bk[y]) { x++; y++; }
            next[offset + k] = x;
            if (x >= n && y >= m) { found = true; break; }
        }
        v = next;
    }
    if (!found) { return undefined; }

    // Walk back from the end, collecting the pairs on the path.
    const pairs: [number, number][] = [];
    let x = n, y = m;
    for (let d = trace.length - 1; d > 0; d--) {
        const round = trace[d];
        const at = (k: number) => round[k + d + 1];
        const k = x - y;
        const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { pairs.push([--x, --y]); }
        x = prevX; y = prevY;
    }
    while (x > 0 && y > 0) { pairs.push([--x, --y]); }
    pairs.reverse();

    // Everything between two pairs is a hunk, and so is a pair whose text
    // differs. They are kept apart, not merged, so a selection can take a
    // re-indented line without the added or removed lines beside it.
    const hunks: LineHunk[] = [];
    const add = (hunk: LineHunk) => {
        if (hunk.aStart !== hunk.aEnd || hunk.bStart !== hunk.bEnd) { hunks.push(hunk); }
    };
    let ai = 0, bi = 0;
    for (const [pa, pb] of [...pairs, [n, m] as [number, number]]) {
        add({ aStart: ai, aEnd: pa, bStart: bi, bEnd: pb });
        if (pa < n && a[pa] !== b[pb]) { add({ aStart: pa, aEnd: pa + 1, bStart: pb, bEnd: pb + 1 }); }
        ai = pa + 1; bi = pb + 1;
    }
    return hunks;
}

/**
 * The edits Format Document would make, kept to the lines `range` covers, for
 * Format Selection. `original` and `formatted` are '\n'-normalised, as for
 * computeLineEdits.
 *
 * The whole page is formatted and the changes are then cut down to the
 * selection, rather than the selection being formatted on its own. Only the
 * whole page says how deep a line is nested — a selection may well hold an
 * `End If` whose `If` is above it — so each selected line gets exactly what
 * Format Document would give it. A change that reaches outside the selection
 * (lines joined across its edge, say) is left out, and the lines outside it are
 * never touched.
 *
 * Undefined when the page changed too much to line the two up.
 */
export function computeRangeEdits(
    document:  vscode.TextDocument,
    original:  string,
    formatted: string,
    eol:       string,
    range:     vscode.Range,
): vscode.TextEdit[] | undefined {
    const a = original.split('\n');
    const b = formatted.split('\n');
    const hunks = alignLines(a, b);
    if (!hunks) { return undefined; }

    // A selection that ends at the start of a line does not take that line in.
    const first = range.start.line;
    const last  = range.end.character === 0 && range.end.line > first ? range.end.line - 1 : range.end.line;

    const edits: vscode.TextEdit[] = [];
    for (const hunk of hunks) {
        const inside = hunk.aStart === hunk.aEnd
            ? first < hunk.aStart && hunk.aStart <= last            // lines added between two selected lines
            : first <= hunk.aStart && hunk.aEnd - 1 <= last;
        if (!inside) { continue; }

        const lines = b.slice(hunk.bStart, hunk.bEnd);
        if (hunk.aEnd < a.length) {
            edits.push(vscode.TextEdit.replace(
                new vscode.Range(hunk.aStart, 0, hunk.aEnd, 0),
                lines.map(line => line + eol).join(''),
            ));
        } else {
            // Reaches the last line, which has no line ending after it.
            const start = hunk.aStart < a.length
                ? new vscode.Position(hunk.aStart, 0)
                : documentEnd(document);
            const text = lines.join(eol);
            edits.push(vscode.TextEdit.replace(
                new vscode.Range(start, documentEnd(document)),
                hunk.aStart < a.length ? text : eol + text,
            ));
        }
    }
    return edits;
}
