import * as assert from 'assert';
import { SUPPRESSED_CODES } from '../../providers/jsDiagnosticsProvider';

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
