import * as assert from 'assert';
import { disposeLog, log } from '../../platform/log';
import { testLog } from './_vscodeStub';

describe('log', () => {
    beforeEach(() => { disposeLog(); testLog.length = 0; });

    it('writes an error once, however often the same failure happens', () => {
        for (let i = 0; i < 3; i++) { log.error('hover failed', new Error('boom')); }
        assert.strictEqual(testLog.length, 1);
        assert.ok(testLog[0].startsWith('error hover failed\nError: boom'), testLog[0]);
    });

});
