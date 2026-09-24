import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { analyseEmbeddedJs, disposeJsAnalysisWorker } from '../../utils/jsAnalysisClient';
import { buildVirtualJsContent, getJsLanguageService } from '../../utils/jsUtils';
import { getJsBlockRanges } from '../../utils/zoneUtils';

// The two always-on JavaScript features — type-aware colouring and the error
// squiggles — are computed on a worker thread instead of the extension host,
// because both are whole-file and both land after every edit.
//
// The risk that carries is drift: the worker is a second copy of the analysis,
// and if it ever stops agreeing with what the extension host would have
// produced, colours and squiggles land in the wrong places with nothing to say
// so. So the substantial test here is differential — for each document, the
// worker's answer must equal the answer the in-process language service gives.
//
// A worker takes a moment to start and to build a TypeScript program, hence the
// generous timeouts; these are not tight-loop tests.

interface Analysis {
    jsRanges: Array<{ start: number; end: number }>;
    preambleLength: number;
    spans: number[];
    diagnostics: Array<{ start: number; length: number; code: number; category: ts.DiagnosticCategory; message: string }>;
}

/** What the extension host itself would produce, with no worker involved. */
function inProcess(text: string): Analysis {
    const jsRanges = getJsBlockRanges(text);
    if (jsRanges.length === 0) { return { jsRanges: [], preambleLength: 0, spans: [], diagnostics: [] }; }

    const { virtualContent, preambleLength } = buildVirtualJsContent(text, 0);
    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);

    const classified = svc.getEncodedSemanticClassifications(0, virtualContent.length);
    const diagnostics: Analysis['diagnostics'] = [];

    for (const d of [...svc.getSyntacticDiagnostics(), ...svc.getSemanticDiagnostics()]) {
        if (d.start === undefined || d.length === undefined) { continue; }
        diagnostics.push({
            start:    d.start,
            length:   d.length,
            code:     typeof d.code === 'number' ? d.code : 0,
            category: d.category,
            message:  typeof d.messageText === 'string'
                ? d.messageText
                : ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        });
    }

    return { jsRanges, preambleLength, spans: Array.from(classified.spans), diagnostics };
}

const CASES: Array<[string, string]> = [
    ['a page with no script at all',
        '<html><body><%= x %><p>hi</p></body></html>'],
    ['one small script',
        '<html><script>var a = 1; a.toFixed(2);</script></html>'],
    ['a genuine type error',
        '<script>var n = 5; n.toUpperCase();</script>'],
    ['a syntax error',
        '<script>function f( { return 1 }</script>'],
    ['a VBScript block beside a JavaScript one',
        '<script language="vbscript">Dim x</script>\n<script>var q = document.getElementById("a"); q.value;</script>'],
    ['an ASP expression inside the script',
        '<script>var u = "<%= Request("id") %>"; u.length;</script>'],
    ['< and > used as operators, not tags',
        '<script>for (var i=0;i<10;i++){ if(i>3){ console.log(i); } }</script>'],
    ['several blocks on one page',
        '<script>var a=1;</script><p>x</p><script>a.toFixed();</script><script>var b="s"; b.length;</script>'],
];

describe('embedded JS analysis — the worker agrees with the extension host', () => {

    after(() => { disposeJsAnalysisWorker(); });

    for (const [name, text] of CASES) {
        it(name, async function () {
            this.timeout(30000);

            const expected = inProcess(text);
            const actual   = await analyseEmbeddedJs('page.asp', text);

            assert.ok(actual, 'the worker returned no analysis');
            assert.deepStrictEqual(actual.jsRanges, expected.jsRanges, 'script ranges');
            assert.strictEqual(actual.preambleLength, expected.preambleLength, 'preamble length');
            assert.deepStrictEqual(actual.spans, expected.spans, 'classification spans');
            assert.deepStrictEqual(actual.diagnostics, expected.diagnostics, 'diagnostics');
        });
    }

    it('agrees on a large real page, token for token', async function () {
        this.timeout(60000);

        const file = path.join(__dirname, '../../../test-files/perf-repros/02-unusable-8k-js.asp');
        if (!fs.existsSync(file)) { this.skip(); }

        const text     = fs.readFileSync(file, 'utf8');
        const expected = inProcess(text);
        const actual   = await analyseEmbeddedJs('page.asp', text);

        assert.ok(actual);
        assert.ok(expected.spans.length > 30000, 'fixture should be large enough to be worth the check');
        assert.deepStrictEqual(actual.spans, expected.spans);
        assert.deepStrictEqual(actual.diagnostics, expected.diagnostics);
    });
});

describe('embedded JS analysis — request handling', () => {

    after(() => { disposeJsAnalysisWorker(); });

    // The worker handles one job at a time and there is no point queueing work
    // for text the user has already typed past, so a request that arrives while
    // another for the same document is waiting replaces it. The displaced
    // caller is answered with undefined rather than a stale result or a
    // rejection.
    it('drops a superseded request instead of queueing it', async function () {
        this.timeout(30000);

        const first  = analyseEmbeddedJs('page.asp', '<script>var one = 1;</script>');
        const second = analyseEmbeddedJs('page.asp', '<script>var two = 2;</script>');
        const third  = analyseEmbeddedJs('page.asp', '<script>var three = 3; three.toFixed();</script>');

        const [a, b, c] = await Promise.all([first, second, third]);

        assert.strictEqual(b, undefined, 'the displaced middle request should resolve undefined');
        assert.ok(c, 'the newest request should be answered');
        assert.ok(c.spans.length > 0);
        // `a` may be answered or displaced depending on whether the worker had
        // already picked it up, so it is deliberately not asserted either way.
        assert.ok(a === undefined || a.jsRanges.length === 1);
    });

    // Newest-wins is per document. With one slot for the whole window, two
    // visible pages knocked each other's requests out, and the loser lost its
    // colouring and had its squiggles cleared until it was next edited.
    it('answers every document when several ask at once', async function () {
        this.timeout(30000);

        const results = await Promise.all([
            analyseEmbeddedJs('busy.asp', '<script>var busy = 1;</script>'),
            analyseEmbeddedJs('a.asp',    '<script>var a = 1;</script>'),
            analyseEmbeddedJs('b.asp',    '<script>var b = 2;</script>'),
        ]);

        for (const result of results) { assert.ok(result, 'every document should be answered'); }
    });

    // Colouring and squiggles both ask about a document after an edit. The
    // second request for the same text shares the first one's answer.
    it('analyses the same text once for two callers', async function () {
        this.timeout(30000);

        const text = '<script>var shared = 1;</script>';
        const [x, y] = await Promise.all([
            analyseEmbeddedJs('page.asp', text),
            analyseEmbeddedJs('page.asp', text),
        ]);

        assert.ok(x);
        assert.strictEqual(x, y, 'both callers should get the one result');
    });

    // Both callers are decoration paths. A failure has to cost one refresh of
    // the colours or the squiggles, never surface as an extension error.
    it('never rejects', async function () {
        this.timeout(30000);
        await assert.doesNotReject(() => analyseEmbeddedJs('page.asp', '<script>function ( ( ( </script>'));
    });

    it('starts a fresh worker after being disposed', async function () {
        this.timeout(30000);

        const before = await analyseEmbeddedJs('page.asp', '<script>var a = 1;</script>');
        assert.ok(before);

        disposeJsAnalysisWorker();

        const after = await analyseEmbeddedJs('page.asp', '<script>var a = 1;</script>');
        assert.ok(after, 'a call after dispose should spawn a new worker');
        assert.deepStrictEqual(after.spans, before.spans);
    });
});
