import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Renaming or moving an include in VS Code left every #include that named it
// pointing at nothing. As for imports when a JavaScript file moves, VS Code now
// asks whether to update them.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

suite('Moving an include offers to update the #include paths (integration)', () => {

    const site = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-rename-'));
    const page = path.join(site, 'page.asp');
    const from = path.join(site, 'lib', 'header.asp');
    const to   = path.join(site, 'shared', 'header.asp');

    suiteSetup(() => {
        fs.mkdirSync(path.join(site, 'lib'));
        fs.mkdirSync(path.join(site, 'shared'));
        fs.writeFileSync(from, '<% Sub Header() : End Sub %>\n');
        fs.writeFileSync(page, '<!--#include file="lib/header.asp"-->\n<% Header %>\n');
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // Windows can hold the folder a moment after the editors close.
        try { fs.rmSync(site, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left in temp */ }
    });

    test('answering Yes points the page at the new place', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('notifications.clearAll');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(page));
        await vscode.window.showTextDocument(doc);

        // As the Explorer does it: through a WorkspaceEdit, which is what
        // raises onDidRenameFiles.
        const move = new vscode.WorkspaceEdit();
        move.renameFile(vscode.Uri.file(from), vscode.Uri.file(to));
        assert.ok(await vscode.workspace.applyEdit(move));

        // The question is a notification; its first button is Yes.
        const expected = '<!--#include file="shared/header.asp"-->';
        const started = Date.now();
        while (doc.lineAt(0).text !== expected && Date.now() - started < 8000) {
            await vscode.commands.executeCommand('notification.acceptPrimaryAction');
            await sleep(200);
        }
        assert.strictEqual(doc.lineAt(0).text, expected);
    });
});
