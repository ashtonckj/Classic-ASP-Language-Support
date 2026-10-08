import * as assert from 'assert';
import {
    editorsToPaint, halfAlpha, hasNonEmptySelection, outsideSelections, overlapWithSelections, splitBySelections,
} from '../../asp/highlight';

// Reported upstream: a TextEditorDecorationType's backgroundColor paints on the
// same layer as the text, above VS Code's own selection highlight, so a
// visible-enough ASP-region colour (the shipped default is deliberately faint)
// made a selection inside a <% %> block invisible — the decoration painted
// right over it.
//
// The fix does not remove the ASP tint wherever a selection overlaps it —
// that loses the "this is ASP code" cue for exactly the text someone is
// looking at. Over the selected part the tint is painted at half strength, so
// the editor's own selection shows through as it does everywhere else. (A
// layer of the theme's selection colour on top of the full tint, the earlier
// fix, counted the selection colour twice there.)
//
// overlapWithSelections gives the selected parts, outsideSelections the rest.

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

describe('overlapWithSelections — no interaction', () => {
    it('is empty when there are no selections', () => {
        assert.deepStrictEqual(overlapWithSelections(range(0, 0, 0, 10), []), []);
    });

    it('is empty for a selection entirely on another line', () => {
        const region = range(5, 0, 5, 10);
        const selection = range(1, 0, 1, 3);
        assert.deepStrictEqual(overlapWithSelections(region, [selection]), []);
    });

    it('is empty for an empty selection (a plain caret) sitting inside the region', () => {
        const region = range(0, 0, 0, 10);
        const caret = range(0, 5, 0, 5);
        assert.deepStrictEqual(overlapWithSelections(region, [caret]), []);
    });

    it('is empty for a selection that only touches the region boundary', () => {
        // Selection ends exactly where the region starts — no overlap.
        const region = range(0, 10, 0, 20);
        const selection = range(0, 0, 0, 10);
        assert.deepStrictEqual(overlapWithSelections(region, [selection]), []);
    });
});

describe('overlapWithSelections — full and partial overlap', () => {
    it('is the whole region when the selection covers it completely', () => {
        const region = range(0, 2, 0, 8);
        const selection = range(0, 0, 0, 20);
        assert.deepStrictEqual(overlapWithSelections(region, [selection]), [region]);
    });

    it('is just the tail when the selection covers the tail', () => {
        const region = range(0, 0, 0, 10);
        const selection = range(0, 6, 0, 10);
        assert.deepStrictEqual(overlapWithSelections(region, [selection]), [range(0, 6, 0, 10)]);
    });

    it('is just the head when the selection covers the head', () => {
        const region = range(0, 0, 0, 10);
        const selection = range(0, 0, 0, 4);
        assert.deepStrictEqual(overlapWithSelections(region, [selection]), [range(0, 0, 0, 4)]);
    });

    it('is just the middle when the selection covers the middle', () => {
        const region = range(0, 0, 0, 10);
        const selection = range(0, 3, 0, 7);
        assert.deepStrictEqual(overlapWithSelections(region, [selection]), [range(0, 3, 0, 7)]);
    });

    it('handles a region spanning several lines, selected in the middle', () => {
        const region = range(0, 0, 5, 0);
        const selection = range(2, 0, 3, 0);
        assert.deepStrictEqual(overlapWithSelections(region, [selection]), [range(2, 0, 3, 0)]);
    });
});

describe('overlapWithSelections — multiple selections (multi-cursor)', () => {
    it('reports one overlap per selection that actually touches the region', () => {
        const region = range(0, 0, 0, 20);
        const selections = [range(0, 2, 0, 5), range(0, 10, 0, 14)];
        assert.deepStrictEqual(
            overlapWithSelections(region, selections),
            [range(0, 2, 0, 5), range(0, 10, 0, 14)],
        );
    });

    it('ignores an empty selection mixed in with a real one', () => {
        const region = range(0, 0, 0, 10);
        const selections = [range(0, 8, 0, 8), range(0, 2, 0, 5)];
        assert.deepStrictEqual(overlapWithSelections(region, selections), [range(0, 2, 0, 5)]);
    });

    it('a selection entirely outside the region contributes nothing', () => {
        const region = range(0, 0, 0, 10);
        const selections = [range(1, 0, 1, 5), range(0, 3, 0, 6)];
        assert.deepStrictEqual(overlapWithSelections(region, selections), [range(0, 3, 0, 6)]);
    });
});

describe('overlapWithSelections — bracket-sized ranges', () => {
    // Brackets are typically just "<%" or "%>" — two characters — so a
    // selection covering part of one should still report exactly that part.
    it('reports half of a two-character bracket when only half is selected', () => {
        const bracket = range(0, 0, 0, 2); // "<%"
        const selection = range(0, 1, 0, 2);
        assert.deepStrictEqual(overlapWithSelections(bracket, [selection]), [range(0, 1, 0, 2)]);
    });

    it('reports the whole bracket when the selection covers all of it', () => {
        const bracket = range(0, 5, 0, 7); // "%>"
        const selection = range(0, 0, 0, 20);
        assert.deepStrictEqual(overlapWithSelections(bracket, [selection]), [bracket]);
    });
});

// The region colours were painted on the focused editor only, whatever its language.
describe('editorsToPaint', () => {
    const editor = (languageId: string) => ({ document: { languageId } });

    it('takes every Classic ASP editor on screen and nothing else', () => {
        const left = editor('asp'), right = editor('asp'), notes = editor('markdown');
        assert.deepStrictEqual(editorsToPaint([left, notes, right]), [left, right]);
    });
});

describe('outsideSelections and splitBySelections — the tint around a selection', () => {
    it('leaves the parts of a region either side of a selection', () => {
        assert.deepStrictEqual(outsideSelections(range(2, 0, 2, 20), [range(2, 5, 2, 8), range(2, 12, 2, 15)]),
            [range(2, 0, 2, 5), range(2, 8, 2, 12), range(2, 15, 2, 20)]);
        assert.deepStrictEqual(outsideSelections(range(2, 0, 2, 20), [range(1, 0, 3, 0)]), []);
    });

    it('splits only the regions a selection reaches, and nothing for a caret', () => {
        const regions = [range(0, 0, 0, 2), range(1, 0, 4, 0), range(6, 0, 6, 2)];
        assert.strictEqual(splitBySelections(regions, [range(2, 3, 2, 3)]), undefined);
        assert.strictEqual(splitBySelections(regions, [range(5, 0, 5, 4)]), undefined);

        const split = splitBySelections(regions, [range(2, 0, 3, 0)])!;
        assert.deepStrictEqual(split.inside, [range(2, 0, 3, 0)]);
        assert.deepStrictEqual(split.outside, [range(0, 0, 0, 2), range(1, 0, 2, 0), range(3, 0, 4, 0), range(6, 0, 6, 2)]);
    });

    it('splits several regions under one selection', () => {
        const regions = [range(0, 0, 0, 2), range(0, 2, 0, 10), range(0, 10, 0, 12)];
        const split = splitBySelections(regions, [range(0, 1, 0, 11)])!;
        assert.deepStrictEqual(split.inside, [range(0, 1, 0, 2), range(0, 2, 0, 10), range(0, 10, 0, 11)]);
        assert.deepStrictEqual(split.outside, [range(0, 0, 0, 1), range(0, 11, 0, 12)]);
    });
});

describe('halfAlpha — the tint at half strength over a selection', () => {
    it('halves rgba(), rgb() and every hex form', () => {
        assert.strictEqual(halfAlpha('rgba(220, 220, 220, 0.04)'), 'rgba(220, 220, 220, 0.02)');
        assert.strictEqual(halfAlpha('rgb(10,20,30)'), 'rgba(10, 20, 30, 0.5)');
        assert.strictEqual(halfAlpha('#ff000080'), 'rgba(255, 0, 0, 0.251)');
        assert.strictEqual(halfAlpha('#f00'), 'rgba(255, 0, 0, 0.5)');
        assert.strictEqual(halfAlpha('#0000ff'), 'rgba(0, 0, 255, 0.5)');
    });

    it('gives nothing for a colour it cannot read', () => {
        assert.strictEqual(halfAlpha('red'), undefined);
        assert.strictEqual(halfAlpha('var(--x)'), undefined);
    });
});
