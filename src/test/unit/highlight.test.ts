import * as assert from 'assert';
import { hasNonEmptySelection, splitByOverlap } from '../../highlight';

// Reported upstream: a TextEditorDecorationType's backgroundColor paints on the
// same layer as the text, above VS Code's own selection highlight. With a
// visible-enough ASP-region colour (the shipped default is deliberately faint),
// a selection inside a <% %> block became invisible: the decoration painted
// right over it. There is no way to ask the renderer to draw a decoration
// behind the selection instead.
//
// The fix does not hide a whole region — or every region in the file — the
// moment any selection exists anywhere. splitByOverlap carves each region into
// the part a selection actually covers (which gets the theme's real selection
// colour instead, so it still reads as a normal selection) and the part it
// doesn't (which keeps the ASP tint, undisturbed).

function pos(line: number, character: number) { return { line, character }; }
function range(startLine: number, startChar: number, endLine: number, endChar: number) {
    return { start: pos(startLine, startChar), end: pos(endLine, endChar) };
}

describe('hasNonEmptySelection', () => {
    it('is false for a single caret with no selection', () => {
        assert.strictEqual(hasNonEmptySelection([{ isEmpty: true }]), false);
    });

    it('is true the moment any text is selected', () => {
        assert.strictEqual(hasNonEmptySelection([{ isEmpty: false }]), true);
    });

    it('is false for an empty list of selections', () => {
        assert.strictEqual(hasNonEmptySelection([]), false);
    });

    it('is true when only one of several cursors has a selection', () => {
        assert.strictEqual(
            hasNonEmptySelection([{ isEmpty: true }, { isEmpty: false }, { isEmpty: true }]),
            true,
        );
    });

    it('is false when every cursor is a plain caret', () => {
        assert.strictEqual(
            hasNonEmptySelection([{ isEmpty: true }, { isEmpty: true }]),
            false,
        );
    });
});

describe('splitByOverlap — no interaction', () => {
    it('returns the whole range unselected when there are no selections', () => {
        const region = range(0, 0, 0, 10);
        const { unselected, selected } = splitByOverlap(region, []);
        assert.deepStrictEqual(unselected, [region]);
        assert.deepStrictEqual(selected, []);
    });

    it('is untouched by a selection entirely on another line', () => {
        const region = range(5, 0, 5, 10);
        const selection = range(1, 0, 1, 3);
        const { unselected, selected } = splitByOverlap(region, [selection]);
        assert.deepStrictEqual(unselected, [region]);
        assert.deepStrictEqual(selected, []);
    });

    it('is untouched by an empty selection (a plain caret) sitting inside it', () => {
        const region = range(0, 0, 0, 10);
        const caret = range(0, 5, 0, 5);
        const { unselected, selected } = splitByOverlap(region, [caret]);
        assert.deepStrictEqual(unselected, [region]);
        assert.deepStrictEqual(selected, []);
    });

    it('is untouched by a selection that only touches its boundary', () => {
        // Selection ends exactly where the region starts — no overlap.
        const region = range(0, 10, 0, 20);
        const selection = range(0, 0, 0, 10);
        const { unselected, selected } = splitByOverlap(region, [selection]);
        assert.deepStrictEqual(unselected, [region]);
        assert.deepStrictEqual(selected, []);
    });
});

describe('splitByOverlap — full and partial overlap', () => {
    it('becomes entirely selected when the selection covers it completely', () => {
        const region = range(0, 2, 0, 8);
        const selection = range(0, 0, 0, 20);
        const { unselected, selected } = splitByOverlap(region, [selection]);
        assert.deepStrictEqual(unselected, []);
        assert.deepStrictEqual(selected, [region]);
    });

    it('splits into a left remainder when the selection covers the tail', () => {
        const region = range(0, 0, 0, 10);
        const selection = range(0, 6, 0, 10);
        const { unselected, selected } = splitByOverlap(region, [selection]);
        assert.deepStrictEqual(unselected, [range(0, 0, 0, 6)]);
        assert.deepStrictEqual(selected, [range(0, 6, 0, 10)]);
    });

    it('splits into a right remainder when the selection covers the head', () => {
        const region = range(0, 0, 0, 10);
        const selection = range(0, 0, 0, 4);
        const { unselected, selected } = splitByOverlap(region, [selection]);
        assert.deepStrictEqual(unselected, [range(0, 4, 0, 10)]);
        assert.deepStrictEqual(selected, [range(0, 0, 0, 4)]);
    });

    it('splits into two remainders when the selection covers the middle', () => {
        const region = range(0, 0, 0, 10);
        const selection = range(0, 3, 0, 7);
        const { unselected, selected } = splitByOverlap(region, [selection]);
        assert.deepStrictEqual(unselected, [range(0, 0, 0, 3), range(0, 7, 0, 10)]);
        assert.deepStrictEqual(selected, [range(0, 3, 0, 7)]);
    });

    it('handles a region spanning several lines, selected in the middle', () => {
        const region = range(0, 0, 5, 0);
        const selection = range(2, 0, 3, 0);
        const { unselected, selected } = splitByOverlap(region, [selection]);
        assert.deepStrictEqual(unselected, [range(0, 0, 2, 0), range(3, 0, 5, 0)]);
        assert.deepStrictEqual(selected, [range(2, 0, 3, 0)]);
    });
});

describe('splitByOverlap — multiple selections (multi-cursor)', () => {
    it('carves out two separate gaps for two separate selections', () => {
        const region = range(0, 0, 0, 20);
        const selections = [range(0, 2, 0, 5), range(0, 10, 0, 14)];
        const { unselected, selected } = splitByOverlap(region, selections);
        assert.deepStrictEqual(unselected, [
            range(0, 0, 0, 2), range(0, 5, 0, 10), range(0, 14, 0, 20),
        ]);
        assert.deepStrictEqual(selected, [range(0, 2, 0, 5), range(0, 10, 0, 14)]);
    });

    it('ignores an empty selection mixed in with a real one', () => {
        const region = range(0, 0, 0, 10);
        const selections = [range(0, 8, 0, 8), range(0, 2, 0, 5)];
        const { unselected, selected } = splitByOverlap(region, selections);
        assert.deepStrictEqual(unselected, [range(0, 0, 0, 2), range(0, 5, 0, 10)]);
        assert.deepStrictEqual(selected, [range(0, 2, 0, 5)]);
    });

    it('a selection entirely outside the region contributes nothing', () => {
        const region = range(0, 0, 0, 10);
        const selections = [range(1, 0, 1, 5), range(0, 3, 0, 6)];
        const { unselected, selected } = splitByOverlap(region, selections);
        assert.deepStrictEqual(unselected, [range(0, 0, 0, 3), range(0, 6, 0, 10)]);
        assert.deepStrictEqual(selected, [range(0, 3, 0, 6)]);
    });
});

describe('splitByOverlap — bracket-sized ranges', () => {
    // Brackets are typically just "<%" or "%>" — two characters — so a
    // selection covering one of them at all should be treated the same way as
    // any other region: only the overlapping slice moves to "selected".
    it('a selection covering half of a two-character bracket splits it', () => {
        const bracket = range(0, 0, 0, 2); // "<%"
        const selection = range(0, 1, 0, 2);
        const { unselected, selected } = splitByOverlap(bracket, [selection]);
        assert.deepStrictEqual(unselected, [range(0, 0, 0, 1)]);
        assert.deepStrictEqual(selected, [range(0, 1, 0, 2)]);
    });

    it('a selection covering the whole bracket moves all of it', () => {
        const bracket = range(0, 5, 0, 7); // "%>"
        const selection = range(0, 0, 0, 20);
        const { unselected, selected } = splitByOverlap(bracket, [selection]);
        assert.deepStrictEqual(unselected, []);
        assert.deepStrictEqual(selected, [bracket]);
    });
});
