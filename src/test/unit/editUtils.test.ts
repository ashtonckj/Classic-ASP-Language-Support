import * as assert from 'assert';
import * as vscode from 'vscode';
import { computeLineEdits, documentEol, resolveEol, toLf } from '../../utils/editUtils';

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
