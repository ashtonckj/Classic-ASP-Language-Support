import * as assert from 'assert';
import * as vscode from 'vscode';

// The SQL warnings were never cleared when a page closed, so they stayed in the
// Problems panel for a page that was no longer open.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (check()) { return true; }
        await sleep(100);
    }
    return false;
}

suite('SQL warnings leave with the page (integration)', () => {

    test('closing the page clears its SQL warnings', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument({
            language: 'asp',
            content: '<%\nDim id, sql\nsql = "SELECT a FROM b WHERE id = "\nsql = sql & id\n%>\n',
        });
        await vscode.window.showTextDocument(doc);
        const uri = doc.uri;
        const sqlWarnings = () => vscode.languages.getDiagnostics(uri).filter(d => d.source === 'ASP SQL');

        assert.ok(await waitFor(() => sqlWarnings().length > 0), 'the page should have a SQL warning');

        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        assert.ok(await waitFor(() => sqlWarnings().length === 0), 'the warning should go with the page');
    });
});
