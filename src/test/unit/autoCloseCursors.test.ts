import * as assert from 'assert';
import {
    typedCharPositions,
    caretsAfterInserts,
    insertedPairPositions,
    shiftQuotePositions,
    type AutoInsertSite,
} from '../../providers/aspIndentProvider';
import * as vscode from 'vscode';

// Auto-close used to read only contentChanges[0] and then assign a single
// editor.selection, so typing `<div>` at three cursors closed one tag and
// collapsed the three cursors into one. These two helpers carry the position
// bookkeeping that lets it serve every cursor.

describe('typedCharPositions', () => {
    it('leaves a single cursor where it was', () => {
        assert.deepStrictEqual(
            typedCharPositions([{ line: 4, character: 10 }]),
            [{ line: 4, character: 10 }],
        );
    });

    it('leaves cursors on different lines alone', () => {
        assert.deepStrictEqual(
            typedCharPositions([
                { line: 1, character: 5 },
                { line: 2, character: 5 },
                { line: 3, character: 5 },
            ]),
            [
                { line: 1, character: 5 },
                { line: 2, character: 5 },
                { line: 3, character: 5 },
            ],
        );
    });

    // Each insertion shifts every later one on the same line by one character.
    it('shifts later cursors on the same line', () => {
        assert.deepStrictEqual(
            typedCharPositions([
                { line: 7, character: 4 },
                { line: 7, character: 9 },
                { line: 7, character: 14 },
            ]),
            [
                { line: 7, character: 4 },
                { line: 7, character: 10 },
                { line: 7, character: 16 },
            ],
        );
    });

    it('sorts changes into document order first', () => {
        // VS Code reports changes end-to-start; the shift maths needs them ascending.
        assert.deepStrictEqual(
            typedCharPositions([
                { line: 7, character: 14 },
                { line: 7, character: 4 },
            ]),
            [
                { line: 7, character: 4 },
                { line: 7, character: 15 },
            ],
        );
    });

    it('counts shifts per line, not across the document', () => {
        assert.deepStrictEqual(
            typedCharPositions([
                { line: 1, character: 2 },
                { line: 1, character: 8 },
                { line: 5, character: 2 },
            ]),
            [
                { line: 1, character: 2 },
                { line: 1, character: 9 },
                { line: 5, character: 2 },
            ],
        );
    });
});

describe('caretsAfterInserts', () => {
    const site = (line: number, at: number, insert?: string, caretOffset = 0): AutoInsertSite =>
        ({ line, at, insert, caretOffset });

    it('puts a single caret just after the typed character', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(3, 6, '</div>')]),
            [{ line: 3, character: 6 }],
        );
    });

    it('offsets the caret into the inserted text when asked', () => {
        // The HTML comment close inserts "  -->" and wants the caret one space in.
        assert.deepStrictEqual(
            caretsAfterInserts([site(3, 6, '  -->', 1)]),
            [{ line: 3, character: 7 }],
        );
    });

    it('leaves carets on different lines unshifted', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(1, 6, '</div>'), site(2, 6, '</div>')]),
            [{ line: 1, character: 6 }, { line: 2, character: 6 }],
        );
    });

    // An insertion at a caret's own column pushes the text after it right and
    // leaves that column alone, so only strictly-earlier insertions count.
    it('shifts a later caret on the same line by the earlier insertion', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(9, 5, '</div>'), site(9, 20, '</div>')]),
            [{ line: 9, character: 5 }, { line: 9, character: 26 }],
        );
    });

    it('accumulates several insertions on one line', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(9, 5, '</b>'), site(9, 10, '</i>'), site(9, 15, '</u>')]),
            [{ line: 9, character: 5 }, { line: 9, character: 14 }, { line: 9, character: 23 }],
        );
    });

    // The whole point: a cursor that gets no closing tag still has to come back,
    // or assigning editor.selections deletes it.
    it('keeps a cursor that gets no insertion', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(1, 6, '</div>'), site(2, 3)]),
            [{ line: 1, character: 6 }, { line: 2, character: 3 }],
        );
    });

    it('shifts an insertion-free cursor that sits after one on the same line', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(4, 5, '</div>'), site(4, 12)]),
            [{ line: 4, character: 5 }, { line: 4, character: 18 }],
        );
    });

    it('does not apply a caret offset to a cursor with no insertion', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(4, 12, undefined, 1)]),
            [{ line: 4, character: 12 }],
        );
    });

    it('sorts sites into document order first', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(9, 20, '</div>'), site(9, 5, '</div>')]),
            [{ line: 9, character: 5 }, { line: 9, character: 26 }],
        );
    });

    it('handles closing tags of different lengths on one line', () => {
        assert.deepStrictEqual(
            caretsAfterInserts([site(2, 4, '</table>'), site(2, 30, '</td>')]),
            [{ line: 2, character: 4 }, { line: 2, character: 38 }],
        );
    });
});

// The VBScript quote guard sees VS Code's auto-closed `''` as change ranges in
// PRE-edit coordinates, and has to find the closing quote after the edit —
// and keep finding it while further edits land before it is removed.
describe('insertedPairPositions', () => {
    it('leaves a single pair where it was typed', () => {
        assert.deepStrictEqual(insertedPairPositions([{ line: 3, character: 8 }]), [{ line: 3, character: 8 }]);
    });

    it('moves later pairs on the same line two columns per earlier pair', () => {
        assert.deepStrictEqual(
            insertedPairPositions([{ line: 1, character: 20 }, { line: 1, character: 4 }, { line: 2, character: 4 }]),
            [{ line: 1, character: 4 }, { line: 1, character: 22 }, { line: 2, character: 4 }],
        );
    });
});

describe('shiftQuotePositions', () => {
    const change = (line: number, from: number, to: number, text: string) => ({
        range: new vscode.Range(new vscode.Position(line, from), new vscode.Position(line, to)),
        text,
    });

    it('moves a quote right when text is typed before it', () => {
        assert.deepStrictEqual(
            shiftQuotePositions([{ line: 0, character: 9 }], [change(0, 9, 9, 'n')]),
            [{ line: 0, character: 10 }],
        );
    });

    it('leaves a quote alone when the edit is after it or on another line', () => {
        const at = [{ line: 0, character: 9 }];
        assert.deepStrictEqual(shiftQuotePositions(at, [change(0, 12, 12, 'x')]), at);
        assert.deepStrictEqual(shiftQuotePositions(at, [change(1, 0, 0, 'x')]), at);
    });

    it('moves a quote left when text before it is deleted', () => {
        assert.deepStrictEqual(
            shiftQuotePositions([{ line: 0, character: 9 }], [change(0, 2, 5, '')]),
            [{ line: 0, character: 6 }],
        );
    });

    it('drops a quote the edit itself deletes', () => {
        assert.deepStrictEqual(shiftQuotePositions([{ line: 0, character: 9 }], [change(0, 9, 10, '')]), []);
    });

    it('drops a quote when an edit adds or removes lines above or at it', () => {
        const newline = { range: new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 3)), text: '\n' };
        assert.deepStrictEqual(shiftQuotePositions([{ line: 0, character: 9 }], [newline]), []);
    });
});
