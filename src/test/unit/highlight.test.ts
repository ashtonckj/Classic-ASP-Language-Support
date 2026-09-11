import * as assert from 'assert';
import { hasNonEmptySelection } from '../../highlight';

// Reported upstream: a TextEditorDecorationType's backgroundColor paints on the
// same layer as the text, above VS Code's own selection highlight. With a
// visible-enough ASP-region colour (a user's own choice — the shipped default is
// deliberately faint), a selection inside a <% %> block became invisible: the
// decoration painted right over it. There is no way to ask the renderer to draw
// a decoration behind the selection instead, so the fix is to stop painting it
// wherever a selection exists, and this predicate is that decision.

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

    // Multi-cursor: dragging just one of several cursors into a selection must
    // still hide the decorations, not just the ones under that cursor — a
    // per-region decoration type has no way to hide only part of itself.
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
