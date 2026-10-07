import * as assert from 'assert';
import * as vscode from 'vscode';
import { BLOCKS_FORMATTING, cssCode, DIAGNOSTIC_SOURCE, DiagnosticCode, DocumentDebouncer, makeDiagnostic } from '../../platform/diagnostics';
import { fakeDocument } from './_helpers';

describe('diagnostics', () => {
    it('gives every diagnostic the one source and its code', () => {
        const range = new vscode.Range(0, 0, 0, 3);
        const d = makeDiagnostic(range, 'x', vscode.DiagnosticSeverity.Hint, 'unused', [vscode.DiagnosticTag.Unnecessary]);
        assert.deepStrictEqual([d.source, d.code, d.tags], [DIAGNOSTIC_SOURCE, 'unused', [vscode.DiagnosticTag.Unnecessary]]);
    });

    it("writes a CSS service code as one of ours", () => {
        assert.strictEqual(cssCode('unknownProperties'), 'css-unknown-properties');
        assert.strictEqual(cssCode('emptyRules'), 'css-empty-rules');
    });

    it('names the problems that stop Format Document, and only those', () => {
        assert.ok(BLOCKS_FORMATTING.has(DiagnosticCode.vbscriptBlock) && BLOCKS_FORMATTING.has(DiagnosticCode.aspTag));
        assert.ok(!BLOCKS_FORMATTING.has(DiagnosticCode.missingSet) && !BLOCKS_FORMATTING.has(DiagnosticCode.sql));
    });
});

describe('DocumentDebouncer', () => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    it('runs once after the last request for a page, and leaves other pages alone', async () => {
        const runs: string[] = [];
        const debouncer = new DocumentDebouncer(20, document => runs.push(document.uri.fsPath));
        const a = fakeDocument('a', { fsPath: '/a.asp' });
        const b = fakeDocument('b', { fsPath: '/b.asp' });
        debouncer.schedule(a);
        debouncer.schedule(b);
        debouncer.schedule(a);
        await wait(60);
        assert.deepStrictEqual(runs.sort(), ['/a.asp', '/b.asp']);
        debouncer.dispose();
    });

    it('drops a waiting run when the page closes or the debouncer is disposed', async () => {
        const runs: string[] = [];
        const debouncer = new DocumentDebouncer(20, document => runs.push(document.uri.fsPath));
        const a = fakeDocument('a', { fsPath: '/a.asp' });
        const b = fakeDocument('b', { fsPath: '/b.asp' });
        debouncer.schedule(a);
        debouncer.cancel(a);
        debouncer.schedule(b);
        debouncer.dispose();
        await wait(60);
        assert.deepStrictEqual(runs, []);
    });
});
