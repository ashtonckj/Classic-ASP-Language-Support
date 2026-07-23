import * as assert from 'assert';
import * as vscode from 'vscode';

// Integration tests: drive the REAL Enter/Tab keybinding commands inside the
// Extension Host and assert the resulting buffer. These catch the class of bug
// the unit harness can't — the handlers only misbehave with a live editor.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function openAsp(content: string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    const editor = await vscode.window.showTextDocument(doc);
    // Normalise indent settings so assertions are deterministic (4 spaces).
    editor.options = { tabSize: 4, insertSpaces: true };
    return editor;
}

function setCursor(editor: vscode.TextEditor, line: number, character: number): void {
    editor.selection = new vscode.Selection(line, character, line, character);
}

// The handlers apply their edits asynchronously (editor.edit(...).then(...)), so
// run the command and wait for the document version to bump before asserting.
async function runAndWait(editor: vscode.TextEditor, command: string): Promise<void> {
    const before = editor.document.version;
    await vscode.commands.executeCommand(command);
    const start = Date.now();
    while (editor.document.version === before && Date.now() - start < 3000) {
        await sleep(20);
    }
    await sleep(40); // let the follow-up selection update settle
}

suite('Enter / Tab handlers (integration)', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension('ashtonckj.classic-asp-language-support');
        await ext?.activate();
    });

    test('Enter between { and } in a <script> block expands with indentation', async () => {
        const editor = await openAsp('<script>\n    function testing() {}\n</script>');
        const braceCol = editor.document.lineAt(1).text.indexOf('{') + 1;
        setCursor(editor, 1, braceCol);

        await runAndWait(editor, 'asp.insertLineBreak');

        const lines = editor.document.getText().split(/\r?\n/);
        assert.strictEqual(lines[1], '    function testing() {');
        assert.strictEqual(lines[2], '        ');           // indented cursor line
        assert.strictEqual(lines[3], '    }');               // } on its own line
        assert.strictEqual(editor.selection.active.line, 2);
        assert.strictEqual(editor.selection.active.character, 8);
    });

    test('Enter at column 0 of a spaces-only line preserves the trailing spaces', async () => {
        const editor = await openAsp('    ');
        setCursor(editor, 0, 0);

        await runAndWait(editor, 'asp.insertLineBreak');

        const lines = editor.document.getText().split(/\r?\n/);
        assert.strictEqual(lines[0], '');       // blank line above
        assert.strictEqual(lines[1], '    ');   // the 4 spaces survive
    });

    test('Tab at column 0 with trailing spaces inserts an indent and keeps the spaces', async () => {
        const editor = await openAsp('    ');
        setCursor(editor, 0, 0);

        await runAndWait(editor, 'asp.insertTab');

        // Native tab inserts one indent (4 spaces) at the cursor; the original 4
        // trailing spaces remain → 8 spaces total.
        assert.strictEqual(editor.document.lineAt(0).text, '        ');
    });

    test('Enter after a VBScript block opener (<% If … Then) indents the body', async () => {
        const editor = await openAsp('<%\nIf x = 1 Then\n%>');
        const eol = editor.document.lineAt(1).text.length; // end of "If x = 1 Then"
        setCursor(editor, 1, eol);

        await runAndWait(editor, 'asp.insertLineBreak');

        const lines = editor.document.getText().split(/\r?\n/);
        assert.strictEqual(lines[1], 'If x = 1 Then');
        assert.strictEqual(lines[2], '    ');   // body indented one level
    });
});
