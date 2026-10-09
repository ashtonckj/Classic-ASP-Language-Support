import * as assert from 'assert';
import { lazyModule } from '../../core/lazyModule';

describe('lazyModule', () => {
    it('loads nothing until asked, then once', () => {
        let loads = 0;
        const load = lazyModule(() => { loads++; return { name: 'heavy' }; });
        assert.strictEqual(loads, 0);
        const first = load();
        assert.strictEqual(load(), first);
        assert.strictEqual(loads, 1);
    });

    it('lets a failed load throw to the caller, and tries again next time', () => {
        let attempts = 0;
        const load = lazyModule(() => { attempts++; if (attempts === 1) { throw new Error('not installed'); } return 42; });
        assert.throws(() => load(), /not installed/);
        assert.strictEqual(load(), 42);
    });
});
