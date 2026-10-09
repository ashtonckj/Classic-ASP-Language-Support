import * as assert from 'assert';
import { testLog } from './_vscodeStub';
import { guarded } from '../../platform/guardedProvider';

const token = (cancelled: boolean) => ({ isCancellationRequested: cancelled, onCancellationRequested: () => ({ dispose() { /* none */ } }) });

class Provider {
    calls = 0;
    private readonly answer = 42;
    provideThing(_doc: unknown, _token?: unknown): number { this.calls++; return this.answer; }
    provideBroken(): number { throw new Error('broken thing'); }
    async provideLater(): Promise<number> { throw new Error('broken later'); }
    prepareRename(): never { throw new Error('This name cannot be renamed.'); }
    helper(): string { throw new Error('not guarded'); }
    onDidChange = () => 'event';
}

describe('guarded providers', () => {
    beforeEach(() => { testLog.length = 0; });

    it('answers as the provider does, with its own fields in reach', () => {
        const provider = guarded('Test', new Provider());
        assert.strictEqual(provider.provideThing({}, token(false)), 42);
        assert.strictEqual(provider.calls, 1);
    });

    it('answers nothing for a request already cancelled, without doing the work', () => {
        const provider = guarded('Test', new Provider());
        assert.strictEqual(provider.provideThing({}, token(true)), undefined);
        assert.strictEqual(provider.calls, 0);
    });

    it('logs an unexpected error once and answers nothing', async () => {
        const provider = guarded('Test', new Provider());
        // The same failure from the same place, as on every keystroke.
        for (let i = 0; i < 3; i++) { assert.strictEqual(provider.provideBroken(), undefined); }
        assert.strictEqual(await provider.provideLater(), undefined);
        assert.strictEqual(testLog.filter(line => line.includes('broken thing')).length, 1);
        assert.ok(testLog.some(line => line.startsWith('error Test: provideLater failed')));
    });

    it('passes on an error meant for the user', () => {
        const provider = guarded('Test', new Provider(), { userErrors: ['prepareRename'] });
        assert.throws(() => provider.prepareRename(), /cannot be renamed/);
    });

    it('leaves other methods and events alone', () => {
        const provider = guarded('Test', new Provider());
        assert.throws(() => provider.helper(), /not guarded/);
        assert.strictEqual(provider.onDidChange(), 'event');
    });
});
