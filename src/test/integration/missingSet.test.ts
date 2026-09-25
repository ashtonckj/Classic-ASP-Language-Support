import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const dir = vscode.Uri.file(os.tmpdir());

// `rs = conn.Execute(sql)` without Set fails only when the page runs. Flagged
// in the editor, with a quick fix that writes the Set.
suite('A missing Set is flagged, with a quick fix (integration)', () => {

    const pageUri = vscode.Uri.joinPath(dir, `asp-missing-set-${process.pid}.asp`);

    function missingSet(uri: vscode.Uri): vscode.Diagnostic[] {
        return vscode.languages.getDiagnostics(uri).filter(d => d.code === 'missing-set');
    }

    async function waitFor(check: () => boolean, timeoutMs = 6000): Promise<boolean> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (check()) { return true; }
            await sleep(100);
        }
        return false;
    }

    suiteSetup(async () => {
        await vscode.workspace.fs.writeFile(pageUri, Buffer.from([
            '<%',
            'Set conn = Server.CreateObject("ADODB.Connection")',
            'rs = conn.Execute(sql)',
            '%>',
            '',
        ].join('\n'), 'utf8'));
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        try { await vscode.workspace.fs.delete(pageUri); } catch { /* already gone */ }
    });

    test('the assignment is flagged, and Add Set fixes it', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument(pageUri);
        await vscode.window.showTextDocument(doc);

        assert.ok(await waitFor(() => missingSet(pageUri).length === 1), 'the missing Set should be flagged');
        const [warning] = missingSet(pageUri);
        assert.strictEqual(doc.getText(warning.range), 'rs');

        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider', pageUri, warning.range, vscode.CodeActionKind.QuickFix.value,
        );
        const addSet = actions?.find(action => action.title === 'Add Set');
        assert.ok(addSet?.edit, `an Add Set quick fix should be offered; got ${JSON.stringify(actions?.map(a => a.title))}`);
        assert.ok(await vscode.workspace.applyEdit(addSet.edit));

        assert.strictEqual(doc.lineAt(2).text, 'Set rs = conn.Execute(sql)');
        assert.ok(await waitFor(() => missingSet(pageUri).length === 0), 'the warning should clear once Set is there');
    });
});
