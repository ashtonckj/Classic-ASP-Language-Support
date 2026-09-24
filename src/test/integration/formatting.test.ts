import * as assert from 'assert';
import * as vscode from 'vscode';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Polls until `find` returns something, or gives up. */
async function waitFor<T>(find: () => T | undefined, timeoutMs = 10000): Promise<T | undefined> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const found = find();
        if (found) { return found; }
        await sleep(100);
    }
    return undefined;
}

// Classic ASP: Preview Formatting shows what Format Document would change and
// changes nothing. It used to be the formatPreview setting, which turned Format
// Document itself into a preview until the setting was switched off again.
suite('Classic ASP: Preview Formatting (integration)', () => {

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('opens a diff of the formatted page and leaves the page as it was', async () => {
        const content = '<div>\n<p>unformatted</p>\n</div>\n';
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('aspLanguageSupport.previewFormatting');

        const preview = await waitFor(() =>
            vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'asp-format-preview'));
        assert.ok(preview, 'a formatting preview should have opened');
        assert.strictEqual(preview.document.getText(), '<div>\n  <p>unformatted</p>\n</div>\n');
        assert.strictEqual(doc.getText(), content, 'the page itself must not change');
    });

    test('is offered in the Command Palette', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('aspLanguageSupport.previewFormatting'));
    });
});
