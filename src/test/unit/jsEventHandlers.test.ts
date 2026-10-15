import * as assert from 'assert';
import * as vscode from 'vscode';
import { createZoneResolver } from '../../core/zoneUtils';
import { buildVirtualJsContent } from '../../js/jsUtils';
import { JsCompletionProvider } from '../../js/jsCompletionProvider';
import { JsRenameProvider } from '../../js/jsRenameProvider';
import { HtmlCompletionProvider } from '../../html/htmlCompletionProvider';
import { analyseEmbeddedJs, disposeAnalysisWorkers } from '../../workers/analysisClient';
import { fakeDocument } from './_helpers';

// A .html file reads an onclick="…" value — any on…="" — as JavaScript: VS
// Code's HTML support puts each value into its embedded JavaScript document
// where it stands, its closing quote turned into the `;` that ends it. A page
// does the same, so the JavaScript features answer there and the markup ones
// do not.

after(() => { disposeAnalysisWorkers(); });

const NOT_CANCELLED = new vscode.CancellationTokenSource().token as vscode.CancellationToken;

const PAGE = [
    '<script>',
    'function save(id) { return id > 0; }',
    '</script>',
    '<form>',
    '<button onclick="return save(<%= id %>);">Save</button>',
    "<select ONCHANGE='this.form.submit()'></select>",
    '<a onclick="save(1)" href="#">x</a>',
    '</form>',
    '',
].join('\r\n');

/** The virtual file's text from the value starting at `value` to past its closing quote. */
function virtualValue(page: string, value: string): string {
    const start = page.indexOf(value);
    return buildVirtualJsContent(page).virtualContent.slice(start, start + value.length + 1);
}

describe('on…="" values in the JavaScript document', () => {
    it('keeps every offset the page\'s, CRLF included', () => {
        const virtual = buildVirtualJsContent(PAGE).virtualContent;
        assert.strictEqual(virtual.length, PAGE.length);
        for (let i = 0; i < PAGE.length; i++) {
            if (PAGE[i] === '\n') { assert.strictEqual(virtual[i], '\n', `offset ${i}`); }
        }
    });

    it('puts each value where it stands, ended by a ; in place of its closing quote, in either quotes', () => {
        assert.strictEqual(virtualValue(PAGE, 'this.form.submit()'), 'this.form.submit();');
        assert.strictEqual(virtualValue(PAGE, 'save(1)'), 'save(1);');
    });

    it('stands an ASP block in a value in for a value, as in a <script>', () => {
        assert.strictEqual(virtualValue(PAGE, 'return save(<%= id %>);'), 'return save(_asp_id  );;');
    });

    it('ends an unquoted value at the character after it', () => {
        const page = '<a onclick=go() href=#>x</a>';
        assert.strictEqual(virtualValue(page, 'go()'), 'go();');
        assert.ok(!buildVirtualJsContent(page).virtualContent.includes('#'), 'the rest of the tag is blank');
    });

    it('leaves out other attributes, a closing tag\'s, and markup written in a VBScript string', () => {
        const page = '<a title="go()" data-onclick="x()">x</a><% Response.Write "<a onclick=""y()"">" %>';
        assert.strictEqual(buildVirtualJsContent(page).virtualContent.trim(), '');
    });
});

describe('the zone of an on…="" value', () => {
    const zones = createZoneResolver(PAGE);

    it('is JavaScript inside the value, either end included, and markup on the attribute name', () => {
        const value = PAGE.indexOf('this.form');
        assert.strictEqual(zones.zoneAt(value), 'js');
        assert.strictEqual(zones.zoneAt(value + 'this.form.submit()'.length), 'js');
        assert.strictEqual(zones.zoneAt(PAGE.indexOf('ONCHANGE') + 2), 'html');
        assert.strictEqual(zones.zoneAt(PAGE.indexOf('href') + 1), 'html');
    });

    it('is ASP inside an ASP block in the value', () => {
        assert.strictEqual(zones.zoneAt(PAGE.indexOf('= id') + 2), 'asp');
    });
});

describe('the JavaScript features in an on…="" value', () => {
    const doc = fakeDocument(PAGE, { fsPath: 'C:\\site\\handlers.asp' });
    const at = (text: string, into = 0) => doc.positionAt(PAGE.indexOf(text) + into);

    it('offers the page\'s functions, and no markup', async function () {
        this.timeout(30000);
        const list = await new JsCompletionProvider().provideCompletionItems(doc, at('save(1)', 2), NOT_CANCELLED, { triggerKind: 0 } as vscode.CompletionContext);
        assert.ok(list?.items.some(item => item.label === 'save'), 'save is offered');
        assert.strictEqual(new HtmlCompletionProvider().provideCompletionItems(doc, at('save(1)', 2)), undefined);
    });

    it('renames a function in the handlers that call it', async function () {
        this.timeout(30000);
        const edit = await new JsRenameProvider().provideRenameEdits(doc, at('save(id)', 1), 'store', NOT_CANCELLED) as vscode.WorkspaceEdit;
        const renamed = edit.get(doc.uri).map(e => doc.offsetAt(e.range.start)).sort((a, b) => a - b);
        assert.deepStrictEqual(renamed, [PAGE.indexOf('save(id)'), PAGE.indexOf('save(<%='), PAGE.indexOf('save(1)')]);
    });

    it('reports a syntax error in a value, but not a return, nor what TypeScript makes of this', async function () {
        this.timeout(30000);
        const page = PAGE.replace('save(1)', 'save(1');
        const analysis = await analyseEmbeddedJs('file:///C:/site/handler-errors.asp', page);
        const inValues = analysis!.diagnostics.filter(d => d.start > page.indexOf('<form>'));
        assert.strictEqual(inValues.length, 1, JSON.stringify(inValues));
        assert.ok(inValues[0].start >= page.indexOf('save(1') && inValues[0].start <= page.indexOf('save(1') + 'save(1'.length + 1);
    });
});
