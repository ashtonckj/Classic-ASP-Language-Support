import * as assert from 'assert';
import * as vscode from 'vscode';

// The unit tests hand the provider a diagnostic directly. This drives the whole
// chain instead: the diagnostics provider notices the misspelling (debounced
// 750 ms), VS Code offers those diagnostics to the code-action provider, and the
// fix comes back attached to them. Only that end-to-end path shows whether the
// action is reachable from the squiggle, which is where a person finds it.
//
// One thing is deliberately NOT asserted here: that the action carries the
// diagnostic it fixes. It does — jsQuickFixes.test.ts in the unit suite checks
// it — but `vscode.executeCodeActionProvider` does not round-trip that field, so
// an assertion on it here would fail for a reason that has nothing to do with
// the provider.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const PAGE = [
    '<html>',
    '<body>',
    '<script>',
    'document.getElementByIdd("btn");',
    '</script>',
    '</body>',
    '</html>',
    '',
].join('\n');

/** Opens the page and waits for the JS diagnostics to land on `needle`. */
async function openAndWaitForSquiggle(
    content: string, needle: string,
): Promise<{ doc: vscode.TextDocument; range: vscode.Range }> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    await vscode.window.showTextDocument(doc);

    const start = content.indexOf(needle);
    assert.ok(start >= 0, `no ${JSON.stringify(needle)} in the fixture`);
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + needle.length));

    // Diagnostics are debounced; poll rather than guess a duration.
    for (let waited = 0; waited < 6000; waited += 100) {
        const here = vscode.languages.getDiagnostics(doc.uri)
            .filter(d => d.source === 'Classic ASP (JS)' && d.range.intersection(range));
        if (here.length) { return { doc, range }; }
        await sleep(100);
    }
    assert.fail('the JS diagnostics never reported the misspelling');
}

suite('Quick fixes reach the JS squiggles in an ASP page (integration)', () => {

    test('a misspelt DOM member offers the corrected spelling', async () => {
        const { doc, range } = await openAndWaitForSquiggle(PAGE, 'getElementByIdd');
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider', doc.uri, range,
        );
        assert.ok(
            (actions ?? []).some(a => a.title.includes('getElementById')),
            `expected a spelling fix; got ${JSON.stringify((actions ?? []).map(a => a.title))}`,
        );
    });

    test('applying the fix corrects the page', async () => {
        const { doc, range } = await openAndWaitForSquiggle(PAGE, 'getElementByIdd');
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider', doc.uri, range,
        );
        const fix = (actions ?? []).find(a => a.title.includes('getElementById'));
        assert.ok(fix?.edit, 'the fix must carry an edit');

        assert.ok(await vscode.workspace.applyEdit(fix.edit), 'the edit should apply');
        assert.strictEqual(
            doc.lineAt(3).text, 'document.getElementById("btn");',
        );
    });
});
