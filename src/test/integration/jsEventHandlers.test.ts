import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';

// An onclick="…" value is JavaScript in a .html file — suggestions, rename and
// the rest come from VS Code's HTML support there — and so it is in a page.
// Run in a real Extension Host, where every provider registered for the page
// answers, so a markup provider answering in the value would show too.

const PAGE = [
    '<script>',
    'function addRow(label) { return label; }',
    '</script>',
    '<button onclick="addRow(\'<%= id %>\'); return false;">Add</button>',
    '',
].join('\n');

let pageUri: vscode.Uri;

suiteSetup(async () => {
    pageUri = vscode.Uri.joinPath(vscode.Uri.file(os.tmpdir()), `asp-handlers-${process.pid}.asp`);
    await vscode.workspace.fs.writeFile(pageUri, Buffer.from(PAGE, 'utf8'));
});

suiteTeardown(async () => {
    try { await vscode.workspace.fs.delete(pageUri); } catch { /* already gone */ }
});

async function openPage(): Promise<vscode.TextDocument> {
    const doc = await vscode.workspace.openTextDocument(pageUri);
    await vscode.window.showTextDocument(doc);
    return doc;
}

suite('JavaScript in an onclick value (integration)', () => {
    test('suggests the page\'s functions, and no tags', async () => {
        const doc = await openPage();
        const at = doc.positionAt(PAGE.indexOf('addRow(\'') + 3);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, at);
        const labels = list.items.map(item => typeof item.label === 'string' ? item.label : item.label.label);
        assert.ok(labels.includes('addRow'), 'addRow is suggested');
        assert.ok(!labels.some(label => label.startsWith('<') || label === 'div'), `no markup: ${labels.slice(0, 20).join(', ')}`);
    });

    test('F2 on the function renames its call in the handler too', async () => {
        const doc = await openPage();
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            'vscode.executeDocumentRenameProvider', doc.uri, doc.positionAt(PAGE.indexOf('addRow') + 1), 'appendRow',
        );
        const starts = (edit?.get(doc.uri) ?? []).map(e => doc.offsetAt(e.range.start)).sort((a, b) => a - b);
        assert.deepStrictEqual(starts, [PAGE.indexOf('addRow'), PAGE.indexOf('addRow(\'')]);
    });
});
