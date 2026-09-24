import * as assert from 'assert';
import * as vscode from 'vscode';

// Close what the test opened. Each test here opens a document and never closed
// it, so across a full run the editors accumulated -- by the time the later
// suites ran there were dozens open at once, and the active editor is what every
// command in this file acts through. Run on its own the suite passed every time;
// run after the others it failed intermittently, always by the command appearing
// to do nothing at all.
teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

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

// Picking an inline tag from the completion list used to lay it out like a
// block — <span>, an indented blank line, then </span> under it — in the middle
// of a line of text. Inline tags now stay on the line; block tags still open up.
suite('Tag completion lays tags out by kind (integration)', () => {

    async function insertTextFor(tag: string): Promise<string | undefined> {
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: '<p>Some text <\n' });
        await vscode.window.showTextDocument(doc);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 14), '<',
        );
        const item = list?.items.find(i => (typeof i.label === 'string' ? i.label : i.label.label) === tag
            && i.insertText instanceof vscode.SnippetString);
        return (item?.insertText as vscode.SnippetString | undefined)?.value;
    }

    test('an inline tag stays on one line', async () => {
        assert.strictEqual(await insertTextFor('span'), 'span>$0</span>');
        assert.strictEqual(await insertTextFor('a'), 'a>$0</a>');
        assert.strictEqual(await insertTextFor('strong'), 'strong>$0</strong>');
    });

    test('a block tag still opens onto its own lines', async () => {
        assert.strictEqual(await insertTextFor('div'), 'div>\n\t$0\n</div>');
    });

    test('a void tag is still self-closed', async () => {
        assert.strictEqual(await insertTextFor('br'), 'br $0/>');
    });
});
