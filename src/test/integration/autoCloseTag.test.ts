import * as assert from 'assert';
import * as vscode from 'vscode';

// Integration tests: drive the REAL `type` command inside the Extension Host so
// the auto-close handler sees a genuine multi-cursor content change. The unit
// tests cover the position arithmetic; only a live editor proves the handler
// wires it up correctly and that the cursors survive.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function openAsp(content: string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    const editor = await vscode.window.showTextDocument(doc);
    editor.options = { tabSize: 4, insertSpaces: true };
    return editor;
}

/**
 * Types `text` at every cursor and waits until `settled` holds, or gives up.
 * Typing bumps the version once and the handler's own edit bumps it again, so
 * polling the document beats counting versions.
 */
async function typeAndWait(
    editor: vscode.TextEditor,
    text: string,
    settled: (doc: vscode.TextDocument) => boolean,
): Promise<void> {
    await vscode.commands.executeCommand('type', { text });
    const start = Date.now();
    while (!settled(editor.document) && Date.now() - start < 3000) {
        await sleep(20);
    }
    await sleep(60); // let the follow-up selection update settle
}

const carets = (editor: vscode.TextEditor) =>
    editor.selections.map(s => `${s.active.line}:${s.active.character}`);

suite('HTML tag auto-close (integration)', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension('ashtonckj.classic-asp-language-support');
        await ext?.activate();
    });

    test('closes the tag and keeps the caret inside it for a single cursor', async () => {
        const editor = await openAsp('<div\n');
        editor.selection = new vscode.Selection(0, 4, 0, 4);

        await typeAndWait(editor, '>', d => d.lineAt(0).text.includes('</div>'));

        assert.strictEqual(editor.document.lineAt(0).text, '<div></div>');
        assert.deepStrictEqual(carets(editor), ['0:5']);
    });

    // The handler used to read only contentChanges[0], so one tag was closed, and
    // then assigned a single editor.selection, collapsing the cursors into one.
    test('closes every tag and keeps every cursor across three lines', async () => {
        const editor = await openAsp('<div\n<div\n<div\n');
        editor.selections = [
            new vscode.Selection(0, 4, 0, 4),
            new vscode.Selection(1, 4, 1, 4),
            new vscode.Selection(2, 4, 2, 4),
        ];

        await typeAndWait(editor, '>', d => d.lineAt(2).text.includes('</div>'));

        const lines = editor.document.getText().split(/\r?\n/);
        assert.strictEqual(lines[0], '<div></div>');
        assert.strictEqual(lines[1], '<div></div>');
        assert.strictEqual(lines[2], '<div></div>');
        assert.deepStrictEqual(carets(editor), ['0:5', '1:5', '2:5']);
    });

    test('closes different tags at different cursors', async () => {
        const editor = await openAsp('<table\n<span\n');
        editor.selections = [
            new vscode.Selection(0, 6, 0, 6),
            new vscode.Selection(1, 5, 1, 5),
        ];

        await typeAndWait(editor, '>', d => d.lineAt(1).text.includes('</span>'));

        const lines = editor.document.getText().split(/\r?\n/);
        assert.strictEqual(lines[0], '<table></table>');
        assert.strictEqual(lines[1], '<span></span>');
        assert.deepStrictEqual(carets(editor), ['0:7', '1:6']);
    });

    // Two cursors on one line: the first insertion shifts the second.
    test('closes two tags on the same line', async () => {
        const editor = await openAsp('<td<td\n');
        editor.selections = [
            new vscode.Selection(0, 3, 0, 3),
            new vscode.Selection(0, 6, 0, 6),
        ];

        await typeAndWait(editor, '>', d => d.lineAt(0).text === '<td></td><td></td>');

        assert.strictEqual(editor.document.lineAt(0).text, '<td></td><td></td>');
        assert.deepStrictEqual(carets(editor), ['0:4', '0:13']);
    });

    // A cursor that gets no closing tag still has to come back, or assigning
    // editor.selections would delete it.
    test('keeps a cursor whose > closes nothing', async () => {
        const editor = await openAsp('<div\nx\n');
        editor.selections = [
            new vscode.Selection(0, 4, 0, 4),
            new vscode.Selection(1, 1, 1, 1),
        ];

        await typeAndWait(editor, '>', d => d.lineAt(0).text.includes('</div>'));

        const lines = editor.document.getText().split(/\r?\n/);
        assert.strictEqual(lines[0], '<div></div>');
        assert.strictEqual(lines[1], 'x>');
        assert.deepStrictEqual(carets(editor), ['0:5', '1:2']);
    });

    test('does not close a self-closing tag', async () => {
        const editor = await openAsp('<br\n<br\n');
        editor.selections = [
            new vscode.Selection(0, 3, 0, 3),
            new vscode.Selection(1, 3, 1, 3),
        ];

        await typeAndWait(editor, '>', d => d.lineAt(1).text === '<br>');

        const lines = editor.document.getText().split(/\r?\n/);
        assert.strictEqual(lines[0], '<br>');
        assert.strictEqual(lines[1], '<br>');
        assert.deepStrictEqual(carets(editor), ['0:4', '1:4']);
    });

    test('does not close a tag inside a VBScript block', async () => {
        const editor = await openAsp('<%\nIf a <div Then\n%>\n');
        const col = editor.document.lineAt(1).text.indexOf('<div') + 4;
        editor.selection = new vscode.Selection(1, col, 1, col);

        await typeAndWait(editor, '>', d => d.lineAt(1).text.includes('>'));

        assert.ok(
            !editor.document.lineAt(1).text.includes('</div>'),
            `no closing tag in VBScript; got ${JSON.stringify(editor.document.lineAt(1).text)}`,
        );
    });
});
