import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';

// The matching-keyword highlight: put the caret on a VBScript block keyword and
// its partner lights up, the way VS Code lights up a matching `{ }` pair.
//
// See regionHighlightSelection.test.ts for why the DECORATION's own pixels are
// not something an automated test can check — setDecorations is a frozen
// property with no public way to ask what was last painted, so that part is a
// manual/visual check. The pairing behind it is covered exhaustively (nesting,
// unclosed blocks, stray closers, one-liners) in aspStructureDiagnostics.test.ts.
//
// What only a live editor can prove is the half that broke during development:
// this decoration is driven from every selection change, which fires
// continuously while dragging and once per character while typing, so the
// update path must stay cheap and must never throw.

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

suite('Matching block keyword highlight (integration)', () => {

    test('moving the caret across a block pair does not throw', async () => {
        const editor = await openPage();

        // Onto the If, onto its End If, onto the enclosing Sub, then off any
        // keyword entirely — every transition the decoration has to handle.
        for (const [line, character] of [[2, 3], [4, 3], [1, 1], [3, 5]]) {
            editor.selection = new vscode.Selection(line, character, line, character);
            await sleep(60);
        }

        assert.strictEqual(editor.selection.active.line, 3);
        assert.strictEqual(editor.selection.active.character, 5);
    });

    test('rapid selection changes, as a drag produces, do not throw', async () => {
        const editor = await openPage();

        // No delay between these at all — the shape that made an earlier,
        // un-debounced version of this provider rescan the whole file per event.
        for (let line = 0; line <= 6; line++) {
            editor.selection = new vscode.Selection(line, 0, line, 0);
        }
        await sleep(300);

        assert.strictEqual(editor.selection.active.line, 6);
    });

    test('editing inside a block leaves the editor consistent', async () => {
        const editor = await openPage();
        editor.selection = new vscode.Selection(3, 9, 3, 9); // end of "    y = 1"

        await editor.edit(b => b.insert(new vscode.Position(3, 9), '0'));
        await sleep(300); // let the debounced rescan run

        assert.strictEqual(editor.document.lineAt(3).text, '    y = 10');
    });
});
