import * as assert from 'assert';
import { disposeLog, log, safely, safelyAsync } from '../../platform/log';
import { testLog } from './_vscodeStub';

describe('log', () => {
    beforeEach(() => { disposeLog(); testLog.length = 0; });

    it('writes an error once, however often the same failure happens', () => {
        for (let i = 0; i < 3; i++) { log.error('hover failed', new Error('boom')); }
        assert.strictEqual(testLog.length, 1);
        assert.ok(testLog[0].startsWith('error hover failed\nError: boom'), testLog[0]);
    });

    it('turns an error thrown by a provider into undefined, and logs it', async () => {
        assert.strictEqual(safely('completion', () => { throw new Error('bad'); }), undefined);
        assert.strictEqual(safely('completion', () => 42), 42);
        assert.strictEqual(await safelyAsync('hover', () => Promise.reject(new Error('worse'))), undefined);
        assert.strictEqual(await safelyAsync('hover', async () => 'ok'), 'ok');
        assert.deepStrictEqual(testLog.map(line => line.split('\n')[0]), ['error completion failed', 'error hover failed']);
    });
});
