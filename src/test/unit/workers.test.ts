import * as assert from 'assert';
import * as path from 'path';
import { Worker } from 'node:worker_threads';

// Each worker entry is started from the compiled output, as the extension
// starts it: one that cannot load a module (vscode, say) fails here, not in
// the editor. A request that throws must come back as an answer marked failed,
// with the error for the log, and leave the worker running.

const WORKERS = path.join(__dirname, '..', '..', 'workers');
const PAGE = '<%\nDim x\nx = 1\nResponse.Write x\n%>\n<script>var a = 1;</script>\n';
const NO_SYMBOLS = { variables: [], constants: [], functions: [], comVariables: [], classes: [] };

interface Answer { id: number; failed?: boolean; error?: string }

/** Sends the requests in turn and resolves with the answers, in order. */
function ask(entry: string, requests: object[]): Promise<Answer[]> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(WORKERS, entry));
        const answers: Answer[] = [];
        worker.on('error', reject);
        worker.on('message', (answer: Answer) => {
            answers.push(answer);
            if (answers.length === requests.length) { void worker.terminate(); resolve(answers); }
        });
        for (const request of requests) { worker.postMessage(request); }
    });
}

describe('worker entries', function () {
    this.timeout(20000);

    const cases: Array<[string, object, object]> = [
        ['jsAnalysisWorker.js',
            { id: 1, text: PAGE },
            { id: 2, text: null }],
        ['vbscriptWorker.js',
            { id: 1, kind: 'page', text: PAGE, docPath: 'C:/page.asp' },
            { id: 2, kind: 'page', text: null, docPath: 'C:/page.asp' }],
        ['aspColouringWorker.js',
            { id: 1, text: PAGE, docPath: 'C:/page.asp', includeSymbols: NO_SYMBOLS },
            { id: 2, text: null, docPath: 'C:/page.asp', includeSymbols: NO_SYMBOLS }],
        ['includeSymbolWorker.js',
            { id: 1, roots: ['C:/inc.asp'], virtualRoot: 'C:/', openFiles: { 'c:/inc.asp': '<% Dim y %>' } },
            { id: 2, roots: null, virtualRoot: 'C:/', openFiles: {} }],
    ];

    for (const [entry, good, bad] of cases) {
        it(`${entry} answers, and answers a request that throws with the error`, async () => {
            const [first, second, third] = await ask(entry, [good, bad, { ...good, id: 3 }]);
            assert.strictEqual(first.id, 1);
            assert.ok(!first.failed);
            assert.strictEqual(second.id, 2);
            assert.strictEqual(second.failed, true);
            assert.match(second.error ?? '', /TypeError/);
            assert.strictEqual(third.id, 3, 'the worker keeps running after a failure');
            assert.ok(!third.failed);
        });
    }

    it('the include worker reads an open file from the text it is sent', async () => {
        const [answer] = await ask('includeSymbolWorker.js', [
            { id: 1, roots: ['C:/inc.asp'], virtualRoot: 'C:/', openFiles: { 'c:/inc.asp': '<% Dim y %>' } },
        ]) as Array<Answer & { entries: Array<{ symbols: { variables: Array<{ name: string }> } }> }>;
        assert.deepStrictEqual(answer.entries.map(e => e.symbols.variables.map(v => v.name)), [['y']]);
    });
});
