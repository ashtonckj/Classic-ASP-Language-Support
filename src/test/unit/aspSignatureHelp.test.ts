import * as assert from 'assert';
import { findActiveCall } from '../../providers/aspSignatureHelpProvider';

// The active-parameter counter must skip string literals: a comma or paren inside
// a string argument is data, not call syntax.
describe('findActiveCall', () => {
    it('does not count a comma inside a string argument', () => {
        assert.deepStrictEqual(findActiveCall('Notify("a, b", '), { openParenCol: 6, activeParam: 1 });
    });

    it('ignores parens inside a string argument', () => {
        assert.strictEqual(findActiveCall('Func("(", ')?.activeParam, 1);
    });

    it('counts real argument separators', () => {
        assert.strictEqual(findActiveCall('Func(a, b, ')?.activeParam, 2);
    });

    it('resolves the innermost call when nested', () => {
        assert.strictEqual(findActiveCall('Func(Other(x, ')?.activeParam, 1);
    });

    it('returns null when the cursor is not inside a call', () => {
        assert.strictEqual(findActiveCall('x = 1 + 2'), null);
    });
});

// A `(` inside a VBScript comment is not call syntax, so commented-out code must
// not raise parameter hints. The scan starts at the line's VBScript so an
// apostrophe in HTML sharing the line is not mistaken for a comment marker.
describe('findActiveCall — comments', () => {
    it('returns null inside a commented-out call', () => {
        assert.strictEqual(findActiveCall("  ' old code: Notify(\"a\", "), null);
    });

    it('returns null when the comment starts mid-line', () => {
        assert.strictEqual(findActiveCall('x = 1 \' Notify(a, '), null);
    });

    it('still resolves a real call that contains an apostrophe in a string', () => {
        assert.strictEqual(findActiveCall('Notify("it\'s", ')?.activeParam, 1);
    });

    it('honours the start offset so HTML on the line is not scanned', () => {
        const line = '<td>it\'s</td><% Notify("a", ';
        assert.strictEqual(findActiveCall(line, line.indexOf('<%') + 2)?.activeParam, 1);
    });
});
