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
