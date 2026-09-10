import * as assert from 'assert';
import * as vscode from 'vscode';
import { JsCodeActionProvider } from '../../providers/jsCodeActionProvider';
import { SUPPRESSED_CODES } from '../../providers/jsDiagnosticsProvider';
import { disposeJsLanguageService } from '../../utils/jsUtils';

// Quick Fixes for the JS squiggles a page already shows. The one that earns its
// keep is the misspelt member: TS2551's message ends "Did you mean
// 'getElementById'?", and TypeScript can hand over the edit that corrects it.
//
// Two things are worth pinning beyond "a fix appears". First, the edit has to
// land on the misspelt identifier and nothing else — the fix arrives in
// virtual-file coordinates, so an unshifted offset would rewrite whatever text
// happens to sit at that position in the page. Second, the provider must only
// ask about codes this extension actually reported: the suppressed codes have no
// squiggle by design, so they must not acquire a lightbulb either.

after(() => { disposeJsLanguageService(); });

const JS_SOURCE = 'Classic ASP (JS)';

function fakeDoc(text: string): vscode.TextDocument {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') { lineStarts.push(i + 1); }
    }
    return {
        languageId: 'asp',
        version: 1,
        uri: { fsPath: 'C:\\site\\page.asp', scheme: 'file', toString: () => 'file:///page.asp' },
        getText: () => text,
        lineCount: lineStarts.length,
        lineAt: (n: number) => ({
            text: text.slice(lineStarts[n], lineStarts[n + 1] ?? text.length).replace(/\r?\n$/, ''),
        }),
        offsetAt: (p: { line: number; character: number }) => lineStarts[p.line] + p.character,
        positionAt: (offset: number) => {
            let lo = 0, hi = lineStarts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
            }
            return new vscode.Position(lo, offset - lineStarts[lo]);
        },
    } as unknown as vscode.TextDocument;
}

const provider      = new JsCodeActionProvider();
const NOT_CANCELLED = { isCancellationRequested: false } as vscode.CancellationToken;

/** A diagnostic shaped like the ones jsDiagnosticsProvider publishes. */
function jsDiagnostic(doc: vscode.TextDocument, needle: string, code: number, text: string) {
    const start = text.indexOf(needle);
    assert.ok(start >= 0, `no ${JSON.stringify(needle)} in the fixture`);
    const range = new vscode.Range(
        doc.positionAt(start), doc.positionAt(start + needle.length),
    );
    const diag = new vscode.Diagnostic(range, `something is wrong with ${needle}`, 0);
    diag.source = JS_SOURCE;
    diag.code   = code;
    return { diag, range };
}

/** Runs the provider over `needle`, reporting `code` there. */
function fixesFor(text: string, needle: string, code: number, source = JS_SOURCE) {
    const doc = fakeDoc(text);
    const { diag, range } = jsDiagnostic(doc, needle, code, text);
    diag.source = source;
    const context = { diagnostics: [diag], only: undefined, triggerKind: 1 } as unknown as vscode.CodeActionContext;
    const actions = provider.provideCodeActions(doc, range, context, NOT_CANCELLED) as vscode.CodeAction[];
    return { doc, actions: actions ?? [] };
}

const MISSPELT_METHOD = '<script>\ndocument.getElementByIdd("btn");\n</script>\n';

describe('Quick fixes for a misspelt member in a <script> block', () => {
    it('offers a fix that names the correct spelling', () => {
        const { actions } = fixesFor(MISSPELT_METHOD, 'getElementByIdd', 2551);
        assert.ok(actions.length, 'expected at least one quick fix');
        assert.ok(
            actions.some(a => a.title.includes('getElementById')),
            `expected the correct spelling in a title; got ${JSON.stringify(actions.map(a => a.title))}`,
        );
    });

    it('edits exactly the misspelt identifier, not the text around it', () => {
        const { doc, actions } = fixesFor(MISSPELT_METHOD, 'getElementByIdd', 2551);
        const fix = actions.find(a => a.title.includes('getElementById'));
        assert.ok(fix?.edit, 'the fix must carry an edit');

        const edits = fix.edit.get(doc.uri);
        assert.strictEqual(edits.length, 1, 'one identifier, one edit');

        const start = doc.offsetAt(edits[0].range.start);
        const end   = doc.offsetAt(edits[0].range.end);
        assert.strictEqual(
            MISSPELT_METHOD.slice(start, end), 'getElementByIdd',
            'the edit must cover the misspelt name',
        );
        assert.strictEqual(edits[0].newText, 'getElementById');
    });

    it('applying the edit produces the corrected line', () => {
        const { doc, actions } = fixesFor(MISSPELT_METHOD, 'getElementByIdd', 2551);
        const fix   = actions.find(a => a.title.includes('getElementById'));
        assert.ok(fix?.edit, 'the fix must carry an edit');
        const edits = fix.edit.get(doc.uri);
        const start = doc.offsetAt(edits[0].range.start);
        const end   = doc.offsetAt(edits[0].range.end);
        const after = MISSPELT_METHOD.slice(0, start) + edits[0].newText + MISSPELT_METHOD.slice(end);

        assert.strictEqual(after, '<script>\ndocument.getElementById("btn");\n</script>\n');
    });

    it('ties the fix to its diagnostic so it appears on the squiggle', () => {
        const { actions } = fixesFor(MISSPELT_METHOD, 'getElementByIdd', 2551);
        const fix = actions.find(a => a.title.includes('getElementById'));
        assert.ok(fix, 'expected the spelling fix');
        assert.ok(fix.diagnostics?.length, 'the action must carry the diagnostic it fixes');
    });

    it('marks the fix as a quick fix', () => {
        const { actions } = fixesFor(MISSPELT_METHOD, 'getElementByIdd', 2551);
        assert.strictEqual(actions[0].kind, vscode.CodeActionKind.QuickFix);
    });

    it('fixes a misspelt string method too', () => {
        const text = '<script>\nvar s = "abc";\ns.toUpperCasee();\n</script>\n';
        const { actions } = fixesFor(text, 'toUpperCasee', 2551);
        assert.ok(
            actions.some(a => a.title.includes('toUpperCase')),
            `expected toUpperCase; got ${JSON.stringify(actions.map(a => a.title))}`,
        );
    });
});

describe('Quick fixes are only offered where they belong', () => {
    it('offers nothing when there are no diagnostics at the range', () => {
        const doc = fakeDoc(MISSPELT_METHOD);
        const start = MISSPELT_METHOD.indexOf('getElementByIdd');
        const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + 15));
        const context = { diagnostics: [], only: undefined, triggerKind: 1 } as unknown as vscode.CodeActionContext;

        assert.strictEqual(
            provider.provideCodeActions(doc, range, context, NOT_CANCELLED), undefined,
        );
    });

    // A diagnostic from another provider (the HTML structure scanner, say) says
    // nothing about the JS, and its code numbers mean something else entirely.
    it('ignores a diagnostic this extension did not publish for the JS', () => {
        const { actions } = fixesFor(MISSPELT_METHOD, 'getElementByIdd', 2551, 'Classic ASP (HTML)');
        assert.deepStrictEqual(actions, []);
    });

    it('declines a range outside a <script> block', () => {
        const text = '<html>\n<body>hello</body>\n</html>\n';
        const doc  = fakeDoc(text);
        const start = text.indexOf('hello');
        const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + 5));
        const diag  = new vscode.Diagnostic(range, 'x', 0);
        diag.source = JS_SOURCE;
        diag.code   = 2551;
        const context = { diagnostics: [diag], only: undefined, triggerKind: 1 } as unknown as vscode.CodeActionContext;

        assert.strictEqual(
            provider.provideCodeActions(doc, range, context, NOT_CANCELLED), undefined,
        );
    });

    // The suppressed codes have no squiggle by design, so a lightbulb for them
    // would contradict that decision. They can never reach the provider, because
    // it reads the codes off diagnostics that were never published — this pins
    // the reasoning rather than the mechanism.
    it('never sees a suppressed code, because none is ever published', () => {
        assert.ok(SUPPRESSED_CODES.has(2304), 'cannot-find-name is suppressed');
        assert.ok(!SUPPRESSED_CODES.has(2551), 'the did-you-mean code must stay visible');
        assert.ok(!SUPPRESSED_CODES.has(2339), 'property-does-not-exist must stay visible');
    });
});
