import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JsCompletionProvider } from '../../js/jsCompletionProvider';
import { JsDefinitionProvider } from '../../js/jsDefinitionProvider';
import { JsHoverProvider } from '../../js/jsHoverProvider';
import { buildVirtualJsContent } from '../../js/jsUtils';
import { analyseEmbeddedJs, disposeAnalysisWorkers } from '../../workers/analysisClient';
import { fakeDocument } from './_helpers';

// Every JavaScript query — completion, hover, definition and the rest — is
// answered by the one TypeScript service, on the JS worker, which also works
// out each page's colouring and squiggles after every edit.

after(() => { disposeAnalysisWorkers(); });

const token = () => new vscode.CancellationTokenSource().token as vscode.CancellationToken;
const completion = new JsCompletionProvider();
const AFTER_DOT = { triggerKind: 1, triggerCharacter: '.' } as vscode.CompletionContext;
const INVOKED   = { triggerKind: 0 } as vscode.CompletionContext;

describe('a JavaScript query while the page is being analysed', () => {
    // The analysis of a large page takes a second or more; a completion must
    // not wait for it. The analysis is stopped and worked out again after.
    it('is answered without waiting for the analysis, which still finishes', async function () {
        this.timeout(120000);
        const file = path.join(__dirname, '../../../test-files/perf-repros/unusable-8k-js.asp');
        if (!fs.existsSync(file)) { this.skip(); }
        const big = fs.readFileSync(file, 'utf8');
        const doc = fakeDocument(big, { fsPath: 'C:\\site\\big.asp' });
        const key = doc.uri.toString();
        const edit = (n: number) => { doc.setText(big.replace('var node', `var node${n}`)); return doc.getText(); };
        const caret = () => doc.positionAt(doc.getText().indexOf('document.getElementById("row3192")') + 'document.'.length);
        const time = async <T>(work: () => Promise<T>) => { const started = performance.now(); const value = await work(); return { value, ms: performance.now() - started }; };

        await analyseEmbeddedJs(key, big);
        const recheck = (await time(() => analyseEmbeddedJs(key, edit(1)))).ms;
        edit(2);
        const alone = (await time(() => completion.provideCompletionItems(doc, caret(), token(), AFTER_DOT))).ms;

        const analysis = analyseEmbeddedJs(key, edit(3));
        await new Promise(resolve => setTimeout(resolve, recheck / 4));
        const during = await time(() => completion.provideCompletionItems(doc, caret(), token(), AFTER_DOT));

        assert.ok(during.value?.items.some(item => item.label === 'getElementById'), 'the completion is answered');
        // Behind the analysis it would wait three quarters of `recheck` more.
        assert.ok(during.ms < alone + recheck / 2,
            `took ${Math.round(during.ms)} ms against ${Math.round(alone)} ms alone, beside a ${Math.round(recheck)} ms re-check`);
        assert.ok((await analysis)?.spans.length, 'the analysis it stopped is worked out after it');
    });
});

describe('JavaScript answers are at the page\'s own offsets', () => {
    // CRLF line ends, characters outside the BMP (two UTF-16 units each), and
    // ASP blocks inside and before the script: none of them may move an offset.
    const PAGE = [
        '<%@ Language="VBScript" %>',
        '<% Const LIMIT = 5 %>',
        '<p>\u{1F600} h\u00e9llo \u{1D4B3}</p>',
        '<script>',
        'var label = "\u{1F600}<%= Request("x") %>";',
        'var total = <%= LIMIT %>;',
        '<% If x Then %>',
        'total.toUpperCase();',
        '<% End If %>',
        'function addRow() { return total + label; }',
        'addRow();',
        '</script>',
        '',
    ].join('\r\n');
    const doc = fakeDocument(PAGE, { fsPath: 'C:\\site\\offsets.asp' });
    const textAt = (range: vscode.Range) => PAGE.slice(doc.offsetAt(range.start), doc.offsetAt(range.end));

    it('builds a virtual file exactly as long as the page', () => {
        assert.strictEqual(buildVirtualJsContent(PAGE).virtualContent.length, PAGE.length);
    });

    it('puts a squiggle on the name it is about', async function () {
        this.timeout(30000);
        const analysis = await analyseEmbeddedJs(doc.uri.toString(), PAGE);
        const problem = analysis?.diagnostics.find(d => d.message.includes('toUpperCase'));
        assert.ok(problem, `expected the number to have no toUpperCase; got ${JSON.stringify(analysis?.diagnostics)}`);
        assert.strictEqual(PAGE.slice(problem.start, problem.start + problem.length), 'toUpperCase');
        const fn = analysis!.outline.find(symbol => symbol.kind === 'function');
        assert.strictEqual(fn && PAGE.slice(fn.nameStart, fn.nameStart + fn.name.length), 'addRow');
    });

    it('goes to the definition and hovers over the name', async function () {
        this.timeout(30000);
        const call = doc.positionAt(PAGE.lastIndexOf('addRow()') + 2);
        const [definition] = await new JsDefinitionProvider().provideDefinition(doc, call, token()) ?? [];
        assert.ok(definition, 'expected a definition');
        assert.strictEqual(doc.offsetAt(definition.range.start), PAGE.indexOf('function addRow') + 'function '.length);
        assert.strictEqual(textAt(definition.range), 'addRow');

        const hover = await new JsHoverProvider().provideHover(doc, doc.positionAt(PAGE.indexOf('total + label') + 1), token());
        assert.ok(hover?.range, 'expected a hover');
        assert.strictEqual(textAt(hover.range), 'total');
    });
});

describe('resolving a completion item', () => {
    // The page moves on while the list is open: the item is resolved against
    // the page as it is now, at the offset the list was worked out for.
    it('fills in the details after the page has changed since the list', async function () {
        this.timeout(30000);
        const page = '<script>\nfunction greet(name) { return name; }\ngr\n</script>\n';
        const doc  = fakeDocument(page, { fsPath: 'C:\\site\\resolve.asp' });
        const list = await completion.provideCompletionItems(doc, doc.positionAt(page.indexOf('\ngr\n') + 3), token(), INVOKED);
        const item = list?.items.find(i => i.label === 'greet');
        assert.ok(item, 'expected greet in the list');

        doc.setText(page.replace('\ngr\n', '\ngre\n'));
        const resolved = await completion.resolveCompletionItem(item, token());
        assert.match(resolved.detail ?? '', /greet\(name: any\)/);
    });
});
