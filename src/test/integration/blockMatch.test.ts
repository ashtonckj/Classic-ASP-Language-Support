import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';

// VBScript has no braces, so it never got VS Code's built-in bracket-match
// highlight or "Go to Bracket" (Ctrl+Shift+\). aspBlockMatchProvider.ts adds
// the equivalent for block keywords (If/End If, Sub/End Sub, ...), reusing the
// exact pairing aspStructureDiagnosticsProvider already computes to report
// mismatches. This drives the real command end-to-end in the Extension Host —
// see regionHighlightSelection.test.ts for why the DECORATION's actual pixels
// aren't something an automated test can check (setDecorations is a frozen,
// unobservable API); the pairing logic itself is covered exhaustively in
// aspStructureDiagnostics.test.ts, so this only needs to prove the command
// moves the caret correctly and that selection changes near a pair don't throw.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const PAGE = [
    '<%',              // 0
    'Sub Foo',         // 1
    '  If x Then',     // 2
    '    y = 1',       // 3
    '  End If',        // 4
    'End Sub',         // 5
    '%>',              // 6
    '',
].join('\n');

let pageUri: vscode.Uri;

suiteSetup(async () => {
    const dir = vscode.Uri.file(os.tmpdir());
    pageUri = vscode.Uri.joinPath(dir, `asp-block-match-${process.pid}.asp`);
    await vscode.workspace.fs.writeFile(pageUri, Buffer.from(PAGE, 'utf8'));
});

suiteTeardown(async () => {
    try { await vscode.workspace.fs.delete(pageUri); } catch { /* already gone */ }
});

async function openPage(): Promise<vscode.TextEditor> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument(pageUri);
    const editor = await vscode.window.showTextDocument(doc);
    await sleep(400);
    return editor;
}

function setCursor(editor: vscode.TextEditor, line: number, character: number): void {
    editor.selection = new vscode.Selection(line, character, line, character);
}

suite('Go to Matching Block Keyword (integration)', () => {

    test('jumps from If to its End If', async () => {
        const editor = await openPage();
        setCursor(editor, 2, 3); // inside "If" on "  If x Then"

        await vscode.commands.executeCommand('asp.goToMatchingBlockKeyword');

        assert.strictEqual(editor.selection.active.line, 4, `expected to land on "End If"'s line; got ${editor.selection.active.line}`);
        assert.strictEqual(editor.document.getText(editor.selection), 'End If');
    });

    test('jumps back from End If to its If', async () => {
        const editor = await openPage();
        setCursor(editor, 4, 3); // inside "End If" on "  End If"

        await vscode.commands.executeCommand('asp.goToMatchingBlockKeyword');

        assert.strictEqual(editor.selection.active.line, 2, `expected to land on "If"'s line; got ${editor.selection.active.line}`);
        assert.strictEqual(editor.document.getText(editor.selection), 'If');
    });

    test('jumps from Sub to its End Sub, skipping the nested If pair', async () => {
        const editor = await openPage();
        setCursor(editor, 1, 1); // inside "Sub" on "Sub Foo" (columns 0-2)

        await vscode.commands.executeCommand('asp.goToMatchingBlockKeyword');

        assert.strictEqual(editor.selection.active.line, 5, `expected to land on "End Sub"'s line; got ${editor.selection.active.line}`);
        assert.strictEqual(editor.document.getText(editor.selection), 'End Sub');
    });

    test('does nothing when the caret is not on a matched keyword', async () => {
        const editor = await openPage();
        setCursor(editor, 3, 5); // "    y = 1" — plain code, not a block keyword
        const before = editor.selection;

        await vscode.commands.executeCommand('asp.goToMatchingBlockKeyword');

        assert.deepStrictEqual(editor.selection, before, 'selection should be unchanged');
    });

    // The decoration itself can't be asserted directly (see file header), but
    // selection changes drive it on every move — including the rapid, no-delay
    // sequence a drag-select produces — and that must never throw.
    test('rapid selection changes across a block pair do not throw', async () => {
        const editor = await openPage();
        for (let line = 0; line <= 6; line++) {
            editor.selection = new vscode.Selection(line, 0, line, 0);
        }
        await sleep(200);
        assert.strictEqual(editor.selection.active.line, 6);
    });
});
