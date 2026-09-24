import * as assert from 'assert';
import * as vscode from 'vscode';

// Rename in a page that has never been saved did nothing: its edits were aimed
// at a file rebuilt from the page's path, file:///Untitled-1, which does not
// exist, so VS Code refused the whole edit.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const PAGE = [
    '<%',
    'Dim total',
    'total = obj.total + 1',
    'x = "total" \' total',
    'Sub Report(total)',
    '  Response.Write total',
    'End Sub',
    'Response.Write total',
    '%>',
    '',
].join('\n');

async function openPage(): Promise<vscode.TextDocument> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: PAGE });
    await vscode.window.showTextDocument(doc);
    await sleep(300);
    return doc;
}

suite('Rename in a VBScript page (integration)', () => {

    test('renames in a page that has never been saved, leaving obj.total alone', async () => {
        const doc = await openPage();
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            'vscode.executeDocumentRenameProvider', doc.uri, new vscode.Position(1, 5), 'sum',
        );
        assert.ok(edit && await vscode.workspace.applyEdit(edit));
        assert.strictEqual(doc.lineAt(2).text, 'sum = obj.total + 1');
        assert.strictEqual(doc.lineAt(7).text, 'Response.Write sum');
        assert.strictEqual(doc.lineAt(5).text, '  Response.Write total', 'the parameter is a different variable');
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
});
