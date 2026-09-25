import * as assert from 'assert';
import { affectsRegionHighlight, editorsToPaint, hasNonEmptySelection, overlapWithSelections } from '../../highlight';

// Reported upstream: a TextEditorDecorationType's backgroundColor paints on the
// same layer as the text, above VS Code's own selection highlight, so a
// visible-enough ASP-region colour (the shipped default is deliberately faint)
// made a selection inside a <% %> block invisible — the decoration painted
// right over it.
//
// The fix does not remove the ASP tint wherever a selection overlaps it —
// that loses the "this is ASP code" cue for exactly the text someone is
// looking at, a bad trade for anyone who spends most of their time selecting
// inside <% %> blocks. Instead the tint is always painted in full, and a
// second decoration — the theme's own selection colour — is layered on TOP of
// it over just the part a selection covers. Two translucent layers on the same
// characters blend, so the result carries both signals at once.
//
// overlapWithSelections computes exactly that second layer's ranges.

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

// The region colours were rebuilt on every settings change and painted on the
// focused editor only, whatever its language.
describe('affectsRegionHighlight', () => {
    const change = (...touched: string[]) => ({
        affectsConfiguration: (section: string) => touched.some(t => t === section || t.startsWith(section + '.')),
    });

    it('is true for the on/off switch and each colour', () => {
        assert.strictEqual(affectsRegionHighlight(change('aspLanguageSupport.highlightAspRegions')), true);
        assert.strictEqual(affectsRegionHighlight(change('aspLanguageSupport.codeBlockDarkColor')), true);
    });

    it('is false for any other setting, this extension\'s included', () => {
        assert.strictEqual(affectsRegionHighlight(change('editor.fontSize')), false);
        assert.strictEqual(affectsRegionHighlight(change('aspLanguageSupport.keywordCase')), false);
    });
});

describe('editorsToPaint', () => {
    const editor = (languageId: string) => ({ document: { languageId } });

    it('takes every Classic ASP editor on screen and nothing else', () => {
        const left = editor('asp'), right = editor('asp'), notes = editor('markdown');
        assert.deepStrictEqual(editorsToPaint([left, notes, right]), [left, right]);
    });
});
