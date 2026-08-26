import * as assert from 'assert';
import {
    typedCharPositions,
    caretsAfterInserts,
    type AutoInsertSite,
} from '../../providers/aspIndentProvider';

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
