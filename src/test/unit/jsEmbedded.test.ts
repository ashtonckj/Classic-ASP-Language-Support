import * as assert from 'assert';
import {
    buildVirtualJsContent, cutAtStatementColon, disposeJsLanguageService,
    getJsLanguageService, substituteAspBlock,
} from '../../utils/jsUtils';
import { getJsBlockRanges } from '../../utils/zoneUtils';
import { SUPPRESSED_CODES } from '../../providers/jsDiagnosticsProvider';

// A Const value must keep a colon that lives inside a string (e.g. a URL) so it
// is typed by its literal, but still cut at a real statement-separating colon.
describe('cutAtStatementColon', () => {
    it('keeps a colon inside a string literal', () => {
        assert.strictEqual(cutAtStatementColon('"http://example.com/app"'), '"http://example.com/app"');
    });
    it('cuts at a statement-separating colon outside a string', () => {
        assert.strictEqual(cutAtStatementColon('1 : Const B = 2').trim(), '1');
    });
});

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

// A <script> is raw text: the first `</script>` closes it, whatever the JS in
// front of it looks like. The projection used to skip `//` as a line comment,
// so a `//` inside a URL string made a one-line block such as
// <script>location.href = "http://x";</script> miss its own close, and the
// markup after it was type-checked as JavaScript — JSX errors on plain HTML.
describe('a <script> block ends at its first </script>', () => {
    after(() => { disposeJsLanguageService(); });

    const markup = '\n<div class="box">Welcome back, <%= userName %></div>\n<p>Your total is below.</p>\n';

    const cases: Record<string, string> = {
        'a URL inside a string': '<script>location.href = "http://example.com/login.asp";</script>',
        'a // comment':          '<script>init(); // loads the grid</script>',
        'a /* */ comment':       '<script>init(); /* loads the grid */</script>',
    };

    for (const [name, script] of Object.entries(cases)) {
        it(`after a one-line block containing ${name}`, () => {
            const text = script + markup + '<script>var later = 1;</script>';

            const [first] = getJsBlockRanges(text);
            assert.strictEqual(first.end, text.indexOf('</script>'), 'the block closes on its own line');

            const { virtualContent, preambleLength } = buildVirtualJsContent(text, 0);
            const svc = getJsLanguageService();
            svc.updateContent(virtualContent);

            const markupStart = script.length;
            const markupEnd   = script.length + markup.length;
            const onMarkup = [...svc.getSyntacticDiagnostics(), ...svc.getSemanticDiagnostics()]
                .filter(d => d.start !== undefined
                    && d.start - preambleLength >= markupStart
                    && d.start - preambleLength < markupEnd);
            assert.deepStrictEqual(onMarkup.map(d => d.code), [], 'no JS diagnostics on the HTML');
        });
    }
});

// Every JS hover, completion and occurrence highlight projects the page afresh,
// and between two keystrokes the projection is the same text. Handing it in as
// a new version anyway made TypeScript rebuild and re-check the program each
// time — a second and a half per hover on a large <script>.
describe('the JS language service reuses its program for unchanged text', () => {
    after(() => { disposeJsLanguageService(); });

    const page = '<script>\n  var total = 1;\n  total.toFixed(2);\n</script>\n';

    it('keeps the same program when the same text is handed in again', () => {
        const svc = getJsLanguageService();
        svc.updateContent(buildVirtualJsContent(page, 0).virtualContent);
        const before = svc.getProgram();
        svc.updateContent(buildVirtualJsContent(page, 0).virtualContent);
        assert.strictEqual(svc.getProgram(), before);
    });

    it('builds a new program once the text changes', () => {
        const svc = getJsLanguageService();
        svc.updateContent(buildVirtualJsContent(page, 0).virtualContent);
        const before = svc.getProgram();
        svc.updateContent(buildVirtualJsContent(page.replace('= 1', '= 2'), 0).virtualContent);
        assert.notStrictEqual(svc.getProgram(), before);
    });
});

// A Const list declares every name in it, so each one is typed in the JavaScript
// projection too — not just the first.
describe('buildVirtualJsContent — a Const list', () => {
    it('declares each constant with its own type', () => {
        const page = '<% Const A = 1, B = "x, y" %>\n<script>\nvar y = 1;\n</script>\n';
        const { virtualContent, preambleLength } = buildVirtualJsContent(page, page.indexOf('var y'));
        const preamble = virtualContent.slice(0, preambleLength);
        assert.ok(preamble.includes('var _asp_A: number;') && preamble.includes('var _asp_B: string;'), preamble);
    });
});
