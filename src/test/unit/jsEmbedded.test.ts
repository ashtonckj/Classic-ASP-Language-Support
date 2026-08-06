import * as assert from 'assert';
import { substituteAspBlock } from '../../utils/jsUtils';
import { SUPPRESSED_CODES } from '../../providers/jsDiagnosticsProvider';

// A statement <% %> block is projected as `_asp;` (a complete statement) so that
// an inline block on the same line as other JS doesn't produce two juxtaposed
// identifiers, which TypeScript rejects as a syntax error (1434). Expression
// blocks stand in for a value and stay `_asp`/sentinel (no semicolon).
describe('substituteAspBlock — statement placeholder is terminated', () => {
    it('gives a statement block a trailing ; and preserves width', () => {
        const out = substituteAspBlock('<% If x Then %>', undefined);
        assert.ok(out.startsWith('_asp;'), `should start with "_asp;"; got ${JSON.stringify(out)}`);
        assert.strictEqual(out.length, '<% If x Then %>'.length, 'width preserved');
    });

    it('leaves an expression block as a bare value (no semicolon)', () => {
        const out = substituteAspBlock('<%= userId %>', '_asp_userId');
        assert.ok(out.startsWith('_asp_userId'), `value token; got ${JSON.stringify(out)}`);
        assert.ok(!out.includes(';'), 'an expression value must not be semicolon-terminated');
    });
});

// Real JS logic errors must surface: 2339 (property does not exist) and 2367
// (comparison has no overlap) are NOT suppressed — ASP-injected values are typed
// `any`, so they never fire those on their own. Environment codes that are noisy
// without whole-project context stay suppressed.
describe('SUPPRESSED_CODES — real logic errors are not suppressed', () => {
    it('does not suppress 2339 or 2367', () => {
        assert.ok(!SUPPRESSED_CODES.has(2339), '2339 (property does not exist) should surface');
        assert.ok(!SUPPRESSED_CODES.has(2367), '2367 (comparison no overlap) should surface');
    });

    it('still suppresses cross-file / environment noise', () => {
        for (const code of [2304, 2592, 7006, 2531, 2532]) {
            assert.ok(SUPPRESSED_CODES.has(code), `${code} should stay suppressed`);
        }
    });
});
