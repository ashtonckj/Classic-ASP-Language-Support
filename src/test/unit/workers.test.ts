import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'node:worker_threads';
import { AnalysisWorker, checkVbscriptPage, colourAspPage, disposeAnalysisWorkers } from '../../workers/analysisClient';
import type { ScopeRequest } from '../../vbscript/pageChecks';

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
        ['vbscriptWorker.js',
            { id: 1, kind: 'colour', text: PAGE, docPath: 'C:/page.asp', includeSymbols: NO_SYMBOLS },
            { id: 2, kind: 'colour', text: null, docPath: 'C:/page.asp', includeSymbols: NO_SYMBOLS }],
        ['vbscriptWorker.js',
            { id: 1, kind: 'includes', text: '<!--#include file="inc.asp"-->', docPath: 'C:/page.asp', configuredRoot: 'C:/', defaultIncludes: [], openFiles: {} },
            { id: 2, kind: 'includes', text: null, docPath: 'C:/page.asp', configuredRoot: 'C:/', defaultIncludes: [], openFiles: {} }],
    ];

    for (const [entry, good, bad] of cases) {
        it(`${entry} answers ${(good as { kind?: string }).kind ?? 'a'} request, and answers one that throws with the error`, async () => {
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

    it('the JavaScript worker sends the Outline, at the page\'s offsets', async () => {
        const page = '<% x = 1 %>\n<script>\nfunction greet(name) {}\nconst API = "x";\n</script>\n';
        const [answer] = await ask('jsAnalysisWorker.js', [{ id: 1, text: page }]) as
            Array<Answer & { outline: Array<{ name: string; kind: string; nameStart: number }> }>;
        assert.deepStrictEqual(answer.outline.map(s => `${s.kind} ${s.name}`), ['function greet', 'constant API']);
        assert.strictEqual(page.slice(answer.outline[0].nameStart, answer.outline[0].nameStart + 5), 'greet');
    });

    // With no site root known, the page checks read a nested virtual= from the
    // include's own folder; completion has to find the same file.
    it('the VBScript worker resolves a nested virtual= from the include\'s folder when no root is known', async () => {
        const inc = path.resolve('/site/lib/inc.asp');
        const [answer] = await ask('vbscriptWorker.js', [{
            id: 1, kind: 'includes', text: '<!--#include file="lib/inc.asp"-->', docPath: path.resolve('/site/page.asp'),
            configuredRoot: undefined, defaultIncludes: [], openFiles: { [inc.toLowerCase()]: '<!--#include virtual="/db.asp"-->' },
        }]) as Array<Answer & { entries: Array<{ children: string[] }> }>;
        assert.deepStrictEqual(answer.entries[0].children, [path.resolve('/site/lib/db.asp')]);
    });

    it('the VBScript worker reads an open include from the text it is sent', async () => {
        const [answer] = await ask('vbscriptWorker.js', [{
            id: 1, kind: 'includes', text: '<!--#include file="inc.asp"-->', docPath: 'C:/page.asp',
            configuredRoot: 'C:/', defaultIncludes: [], openFiles: { [path.resolve('C:/inc.asp').toLowerCase()]: '<% Dim y %>' },
        }]) as Array<Answer & { entries: Array<{ symbols: { variables: Array<{ name: string }> } }> }>;
        assert.deepStrictEqual(answer.entries.map(e => e.symbols.variables.map(v => v.name)), [['y']]);
    });
});

// The colouring shares the VBScript worker with the checks, which bind a page
// with all its includes; it must not wait for them to finish.
describe('VBScript worker jobs', function () {
    this.timeout(60000);
    after(() => { disposeAnalysisWorkers(); });

    /** A page with 30 large includes, each a little different per `run` so none is parsed already. */
    const withIncludes = (run: string): ScopeRequest => {
        const openFiles: Record<string, string> = {};
        const directives: string[] = [];
        for (let i = 0; i < 30; i++) {
            openFiles[path.resolve(`C:/site/inc${i}.asp`).toLowerCase()] =
                `<%\n${Array.from({ length: 1500 }, (_, j) => `Dim v${run}_${i}_${j} : v${run}_${i}_${j} = ${j} & "x"`).join('\n')}\n%>`;
            directives.push(`<!--#include file="inc${i}.asp"-->`);
        }
        // A local never used, for the checks to find.
        return { text: `${directives.join('\n')}\n<%\nSub S()\nDim unused\nEnd Sub\n%>`, docPath: path.resolve('C:/site/page.asp'), configuredRoot: path.resolve('C:/site'), defaultIncludes: [], openFiles };
    };

    it('answers the colouring asked for while checks run, then still finishes the checks', async () => {
        let start = Date.now();
        const alone = await checkVbscriptPage('alone.asp', withIncludes('a'));
        const checksAlone = Date.now() - start;
        assert.ok(alone && alone.checks.length > 0);

        const request = withIncludes('b');
        start = Date.now();
        const order: string[] = [];
        const checks = checkVbscriptPage('page.asp', request).then(r => { order.push('checks'); return r; });
        await new Promise(r => setTimeout(r, 10));
        const colour = await colourAspPage('page.asp', request.text, request.docPath, NO_SYMBOLS);
        const colourMs = Date.now() - start;
        order.push('colour');

        assert.ok(colour && !colour.failed);
        assert.ok(colourMs < checksAlone / 2, `colour took ${colourMs} ms; checks alone ${checksAlone} ms`);
        const finished = await checks;
        assert.deepStrictEqual(order, ['colour', 'checks']);
        assert.deepStrictEqual(finished?.checks.map(c => c.message), alone.checks.map(c => c.message));
    });
});

// A worker stuck in a loop on one page used to hold its feature up for good:
// nothing answered, and every later request waited behind it.
describe('AnalysisWorker', function () {
    this.timeout(20000);
    let dir: string;
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-worker-'));
        fs.writeFileSync(path.join(dir, 'echo.js'), [
            "const { parentPort } = require('node:worker_threads');",
            'parentPort.on(\'message\', m => { if (m.hang) { for (;;) { /* stuck */ } } parentPort.postMessage({ id: m.id, value: m.value }); });',
        ].join('\n'));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('gives up on a job that takes too long, and the next one gets a fresh worker', async () => {
        const worker = new AnalysisWorker<{ hang?: boolean; value?: number }, Answer & { value?: number }>(
            'test', path.join(dir, 'echo.js'), () => false, () => false, () => false, 200);
        try {
            assert.strictEqual(await worker.request('page', { hang: true }), undefined);
            assert.strictEqual((await worker.request('page', { value: 7 }))?.value, 7);
        } finally {
            worker.dispose();
        }
    });
});
