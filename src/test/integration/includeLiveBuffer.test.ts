import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';

// Include files are parsed by a worker thread, which has no vscode API and so
// can only read what is on disk. Left at that, an unsaved edit to an include was
// invisible to the page including it — you had to press Ctrl+S before the new
// function appeared. Every mainstream language server resolves an open
// dependency from the editor buffer instead, and the worker can too: the
// extension host reads the dirty buffers and sends the text with the request.
//
// This drives the real completion provider, so it covers the whole path —
// buffer collection, worker round trip, cache staleness on the next keystroke.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const dir     = vscode.Uri.file(os.tmpdir());
const LIB_NAME = `asp-live-lib-${process.pid}.asp`;
const libUri  = vscode.Uri.joinPath(dir, LIB_NAME);
const pageUri = vscode.Uri.joinPath(dir, `asp-live-page-${process.pid}.asp`);

const LIB_ON_DISK = [
    '<%',
    'Function SavedOnlyFunction(a)',
    '  SavedOnlyFunction = a',
    'End Function',
    '%>',
    '',
].join('\n');

function page(): string {
    return [
        '<%@ LANGUAGE="VBSCRIPT" %>',
        `<!--#include file="${LIB_NAME}"-->`,
        '<%',
        '  Dim result',
        '  result = 1',
        '%>',
        '',
    ].join('\n');
}

/** Completion labels offered inside the page's <% %> block. */
async function labelsInPage(doc: vscode.TextDocument): Promise<string[]> {
    const pos  = doc.lineAt(3).range.end; // end of "  Dim result"
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', doc.uri, pos,
    );
    return (list?.items ?? []).map(i => (typeof i.label === 'string' ? i.label : i.label.label));
}

/** Polls until `name` is offered, or gives up — the worker is asynchronous. */
async function waitForLabel(doc: vscode.TextDocument, name: string, timeoutMs = 6000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if ((await labelsInPage(doc)).includes(name)) { return true; }
        await sleep(150);
    }
    return false;
}

suite('Include symbols follow the editor buffer (integration)', () => {

    suiteSetup(async () => {
        await vscode.workspace.fs.writeFile(libUri, Buffer.from(LIB_ON_DISK, 'utf8'));
        await vscode.workspace.fs.writeFile(pageUri, Buffer.from(page(), 'utf8'));
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        for (const uri of [libUri, pageUri]) {
            try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ }
        }
    });

    test('a function added to an include WITHOUT saving is offered in the including page', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        const pageDoc = await vscode.workspace.openTextDocument(pageUri);
        await vscode.window.showTextDocument(pageDoc);

        // The saved copy's function should arrive once the worker has run.
        assert.ok(
            await waitForLabel(pageDoc, 'SavedOnlyFunction'),
            'the include\'s saved function should be offered',
        );

        // Now edit the include and leave it dirty — no save.
        const libDoc    = await vscode.workspace.openTextDocument(libUri);
        const libEditor = await vscode.window.showTextDocument(libDoc);
        await libEditor.edit(b => b.insert(
            new vscode.Position(4, 0),
            'Function UnsavedFunction(b)\n  UnsavedFunction = b\nEnd Function\n',
        ));
        assert.strictEqual(libDoc.isDirty, true, 'the include must be dirty for this test to mean anything');

        // Back to the page: the unsaved function should now be offered too.
        await vscode.window.showTextDocument(pageDoc);
        assert.ok(
            await waitForLabel(pageDoc, 'UnsavedFunction'),
            'a function added to the include but not saved should still be offered',
        );

        // …and the saved one must not have been lost along the way.
        assert.ok(
            (await labelsInPage(pageDoc)).includes('SavedOnlyFunction'),
            'the previously saved function should still be offered',
        );
    });
});
