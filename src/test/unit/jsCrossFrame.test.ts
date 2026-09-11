import * as assert from 'assert';
import {
    buildVirtualJsContent,
    collectCrossFrameNames,
    disposeJsLanguageService,
    getJsLanguageService,
    getJsRanges,
} from '../../utils/jsUtils';
import { SUPPRESSED_CODES } from '../../providers/jsDiagnosticsProvider';

// A Classic ASP modal reaching back into the page that opened it —
// window.parent.RefreshGrid(...) — was reported as "property does not exist",
// because the receiver is typed Window. There is nothing to check it against
// either: the function lives in a different document. Those names are now
// harvested out of the document and declared for it.
//
// The line that matters is between "another frame" and "this frame": a global on
// THIS page is knowable, so window.somethingMisspelt must stay an error.

after(() => { disposeJsLanguageService(); });

const namesIn = (scriptBody: string): string[] => {
    const fullText = `<script>\n${scriptBody}\n</script>\n`;
    return [...collectCrossFrameNames(fullText, getJsRanges(fullText))].sort();
};

describe('collectCrossFrameNames', () => {
    it('picks up a name read off parent, top or opener', () => {
        assert.deepStrictEqual(namesIn('parent.RefreshGrid();'), ['RefreshGrid']);
        assert.deepStrictEqual(namesIn('top.myCallback("x");'), ['myCallback']);
        assert.deepStrictEqual(namesIn('opener.reloadList();'), ['reloadList']);
    });

    it('picks up the window-prefixed form', () => {
        assert.deepStrictEqual(namesIn('window.parent.RefreshGrid();'), ['RefreshGrid']);
        assert.deepStrictEqual(namesIn('window.top.SaveAll();'), ['SaveAll']);
    });

    it('picks up a chained frame walk', () => {
        assert.deepStrictEqual(namesIn('parent.parent.DeepCall();'), ['DeepCall']);
        assert.deepStrictEqual(namesIn('window.parent.top.DeepCall();'), ['DeepCall']);
    });

    it('tolerates whitespace around the dots', () => {
        assert.deepStrictEqual(namesIn('parent . RefreshGrid ();'), ['RefreshGrid']);
    });

    it('collects every distinct name once', () => {
        assert.deepStrictEqual(
            namesIn('parent.A(); top.B(); parent.A(); window.parent.C();'),
            ['A', 'B', 'C'],
        );
    });

    // This is the whole boundary: same-frame access stays checked.
    it('does not harvest a same-frame window property', () => {
        assert.deepStrictEqual(namesIn('window.somethingMisspelt();'), []);
        assert.deepStrictEqual(namesIn('window.myGlobal = 1;'), []);
    });

    // Declaring one of these as `any` would clash with the real declaration and
    // throw away type information on an API that works.
    it('skips members Window genuinely has', () => {
        assert.deepStrictEqual(namesIn('parent.document.getElementById("x");'), []);
        assert.deepStrictEqual(namesIn('parent.location.href = "/x.asp";'), []);
        assert.deepStrictEqual(namesIn('top.close();'), []);
        assert.deepStrictEqual(namesIn('parent.$("#m").dialog("close");'), []);
    });

    // Those are covered by a pattern index signature in asp-dom.d.ts already.
    it('skips the generated ASP stand-ins', () => {
        assert.deepStrictEqual(namesIn('top._asp_callback("x");'), []);
    });

    it('ignores frame calls written outside a script block', () => {
        const html = '<p>parent.NotCode()</p>\n<% x = "top.AlsoNotCode()" %>\n';
        assert.deepStrictEqual([...collectCrossFrameNames(html, getJsRanges(html))], []);
    });
});

/** The error codes the extension would actually show for one <script> body. */
function shownCodes(scriptBody: string): number[] {
    const fullText = `<script>\n${scriptBody}\n</script>\n`;
    const jsRanges = getJsRanges(fullText);
    if (jsRanges.length === 0) { return []; }

    const { virtualContent, preambleLength } = buildVirtualJsContent(fullText, 0);
    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);

    return [...svc.getSyntacticDiagnostics(), ...svc.getSemanticDiagnostics()]
        .filter(d => d.start !== undefined && d.length !== undefined)
        .filter(d => {
            const offset = d.start! - preambleLength;
            return jsRanges.some(r => offset >= r.start && offset <= r.end);
        })
        .filter(d => !SUPPRESSED_CODES.has(d.code))
        .map(d => d.code);
}

describe('cross-frame calls type-check end to end', () => {
    const clean = (body: string) =>
        assert.deepStrictEqual(shownCodes(body), [], `expected no errors for ${JSON.stringify(body)}`);
    const flagged = (body: string) =>
        assert.ok(shownCodes(body).length > 0, `expected an error for ${JSON.stringify(body)}`);

    it('accepts calling a function on the parent page', () => {
        clean('if (window.parent && window.parent.RefreshParentGrid) { window.parent.RefreshParentGrid(1); }');
    });

    it('accepts the typeof-guarded callback pattern', () => {
        clean('if (typeof(top.myCallback) == "function") { top.myCallback("ok"); }');
    });

    it('accepts reading a value off the opener', () => {
        clean('var v = opener.selectedRowId;');
    });

    it('accepts a chained frame walk', () => {
        clean('parent.parent.NotifyRoot("done");');
    });

    // The boundary, again, end to end.
    it('still reports a misspelt same-frame window property', () => {
        flagged('window.docuemnt.getElementById("x");');
        flagged('window.thisWasNeverDefined();');
    });

    it('still reports a misspelt document method after a frame call', () => {
        flagged('parent.RefreshGrid(); document.getElementByIdd("x");');
    });
});
