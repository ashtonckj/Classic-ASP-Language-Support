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

// Format Selection (Ctrl+K Ctrl+F) had nothing to run: only Format Document
// was provided. It now does what Format Document would, on the selected lines.
suite('Format Selection (integration)', () => {

    const PAGE = '<div>\n<p>one</p>\n<%\nIf a Then\nx = 1\ny = 2\nEnd If\n%>\n<p>two</p>\n</div>\n';
    const options: vscode.FormattingOptions = { tabSize: 4, insertSpaces: true };

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    test('formats the selected line as Format Document would, and nothing else', async () => {
        // What Format Document makes of the page, for comparison.
        const whole = await vscode.workspace.openTextDocument({ language: 'asp', content: PAGE });
        const docEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatDocumentProvider', whole.uri, options,
        );
        const everything = new vscode.WorkspaceEdit();
        everything.set(whole.uri, docEdits ?? []);
        assert.ok(await vscode.workspace.applyEdit(everything));
        const formattedLine = whole.getText().split('\n').find(line => line.trim() === 'x = 1');
        assert.ok(formattedLine && formattedLine !== 'x = 1', 'Format Document should indent the line');

        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: PAGE });
        await vscode.window.showTextDocument(doc);
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatRangeProvider', doc.uri, new vscode.Range(4, 0, 4, 5), options,
        );
        const selection = new vscode.WorkspaceEdit();
        selection.set(doc.uri, edits ?? []);
        assert.ok(await vscode.workspace.applyEdit(selection));

        const expected = PAGE.split('\n');
        expected[4] = formattedLine;
        assert.strictEqual(doc.getText(), expected.join('\n'));
    });
});
