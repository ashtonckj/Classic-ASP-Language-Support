import * as assert from 'assert';
import * as vscode from 'vscode';
import { alignLines, computeLineEdits, computeRangeEdits, documentEol, resolveEol, toLf } from '../../utils/editUtils';

// Minimal TextDocument stand-in: computeLineEdits only reads lineCount, lineAt,
// and eol.
function fakeDoc(text: string, eol: number = vscode.EndOfLine.LF): vscode.TextDocument {
    const lines = text.split(/\r\n|\n/);
    return {
        eol,
        lineCount: lines.length,
        lineAt: (n: number) => ({ text: lines[n] }),
    } as unknown as vscode.TextDocument;
}

const CRLF = vscode.EndOfLine.CRLF;

describe('toLf', () => {
    it('normalises CRLF and lone CR to LF', () => {
        assert.strictEqual(toLf('a\r\nb\rc\nd'), 'a\nb\nc\nd');
    });
    it('leaves LF-only text untouched', () => {
        assert.strictEqual(toLf('a\nb\n'), 'a\nb\n');
    });
});

describe('resolveEol', () => {
    it('follows the document for "auto"', () => {
        assert.strictEqual(resolveEol('auto', fakeDoc('a', CRLF)), '\r\n');
        assert.strictEqual(resolveEol('auto', fakeDoc('a')), '\n');
    });
    it('follows the document for an unset/unknown value', () => {
        assert.strictEqual(resolveEol('', fakeDoc('a', CRLF)), '\r\n');
    });
    it('honours an explicit override against the document', () => {
        assert.strictEqual(resolveEol('lf',   fakeDoc('a', CRLF)), '\n');
        assert.strictEqual(resolveEol('crlf', fakeDoc('a')),       '\r\n');
        assert.strictEqual(resolveEol('cr',   fakeDoc('a')),       '\r');
    });
});

describe('documentEol', () => {
    it('reports the document line ending', () => {
        assert.strictEqual(documentEol(fakeDoc('a', CRLF)), '\r\n');
        assert.strictEqual(documentEol(fakeDoc('a')), '\n');
    });
});

// The whole point of line-level edits: a file where one line moved must produce
// one small edit, not a full-document replacement (which marks every line dirty
// in the gutter and jumps the caret to the end of the file).
describe('computeLineEdits', () => {
    const original  = 'a\nb\nc\nd\n';
    const formatted = 'a\nB\nc\nd\n';

    it('emits a single edit covering only the changed line', () => {
        const edits = computeLineEdits(fakeDoc(original), original, formatted, '\n');
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].range.start.line, 1);
        assert.strictEqual(edits[0].range.end.line, 2);
        assert.strictEqual(edits[0].newText, 'B\n');
    });

    it('emits nothing when the text is already formatted', () => {
        assert.deepStrictEqual(computeLineEdits(fakeDoc(original), original, original, '\n'), []);
    });

    // A CRLF file used to diff LF-formatted output against CRLF source, so every
    // line differed and the whole document was replaced — and rewritten LF-only.
    it('touches only the changed line in a CRLF document', () => {
        const doc   = fakeDoc(original.replace(/\n/g, '\r\n'), CRLF);
        const edits = computeLineEdits(doc, original, formatted, '\r\n');
        assert.strictEqual(edits.length, 1, 'one line changed, so one edit');
        assert.strictEqual(edits[0].range.start.line, 1);
    });

    it('writes the replacement text with the requested line ending', () => {
        const doc   = fakeDoc(original.replace(/\n/g, '\r\n'), CRLF);
        const edits = computeLineEdits(doc, 'a\nb\nc\nd\n', 'a\nB\nC\nd\n', '\r\n');
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].newText, 'B\r\nC\r\n');
    });

    it('groups consecutive changed lines into one edit', () => {
        const edits = computeLineEdits(fakeDoc('a\nb\nc\nd\n'), 'a\nb\nc\nd\n', 'a\nB\nC\nd\n', '\n');
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].newText, 'B\nC\n');
    });

    it('extends the last edit to the end of the document when lines are removed', () => {
        const doc   = fakeDoc('a\nb\nc\n');
        const edits = computeLineEdits(doc, 'a\nb\nc\n', 'a\n', '\n');
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].range.start.line, 1);
        assert.strictEqual(edits[0].range.end.line, doc.lineCount - 1);
    });
});

// Format Selection formats the whole page and keeps the changes that fall in
// the selection. A line-by-line comparison cannot find them once formatting
// adds or removes a line — every line after it would count as changed — so the
// two texts are lined up first.
describe('alignLines', () => {
    it('pairs lines that only moved in their indentation, and reports them', () => {
        assert.deepStrictEqual(
            alignLines(['<%', 'If a Then', 'x = 1', 'End If', '%>'], ['<%', 'If a Then', '    x = 1', 'End If', '%>']),
            [{ aStart: 2, aEnd: 3, bStart: 2, bEnd: 3 }],
        );
    });

    it('lines up the rest after a line is removed', () => {
        assert.deepStrictEqual(alignLines(['a', 'x', 'b', ' c'], ['a', 'b', 'c']), [
            { aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 },
            { aStart: 3, aEnd: 4, bStart: 2, bEnd: 3 },
        ]);
    });

    it('is empty for identical texts', () => {
        assert.deepStrictEqual(alignLines(['a', 'b'], ['a', 'b']), []);
    });
});

describe('computeRangeEdits', () => {
    function formatRange(original: string, formatted: string, range: vscode.Range): string {
        const edits = computeRangeEdits(fakeDoc(original), original, formatted, '\n', range)!;
        const lines = original.split('\n');
        const offsetOf = (p: vscode.Position) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
        let text = original;
        for (const edit of [...edits].reverse()) {
            text = text.slice(0, offsetOf(edit.range.start)) + edit.newText + text.slice(offsetOf(edit.range.end));
        }
        return text;
    }

    const original  = '<%\nIf a Then\nx = 1\ny = 2\nEnd If\n%>';
    const formatted = '<%\nIf a Then\n    x = 1\n    y = 2\nEnd If\n%>';

    it('changes only the selected lines, indented as the whole page says', () => {
        assert.strictEqual(
            formatRange(original, formatted, new vscode.Range(2, 0, 2, 5)),
            '<%\nIf a Then\n    x = 1\ny = 2\nEnd If\n%>',
        );
    });

    it('does all of Format Document when everything is selected', () => {
        assert.strictEqual(formatRange(original, formatted, new vscode.Range(0, 0, 5, 2)), formatted);
    });

    it('does not take in the line a selection ends at the start of', () => {
        assert.strictEqual(
            formatRange(original, formatted, new vscode.Range(2, 0, 3, 0)),
            '<%\nIf a Then\n    x = 1\ny = 2\nEnd If\n%>',
        );
    });

    it('leaves out a change that reaches past the selection', () => {
        // Formatting joins lines 1 and 2; with only line 1 selected, taking that
        // would rewrite line 2 as well.
        const joined = formatRange('<%\nx = a\n+ b\n%>', '<%\nx = a + b\n%>', new vscode.Range(1, 0, 1, 5));
        assert.strictEqual(joined, '<%\nx = a\n+ b\n%>');
        assert.strictEqual(formatRange('<%\nx = a\n+ b\n%>', '<%\nx = a + b\n%>', new vscode.Range(1, 0, 2, 3)), '<%\nx = a + b\n%>');
    });
});
