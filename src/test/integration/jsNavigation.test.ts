import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';

// A Classic ASP page now has TWO definition providers and TWO rename providers
// registered against the same language: one pair for VBScript names and
// #include paths, one pair for symbols in <script> blocks. VS Code asks all of
// them and takes what it gets, so each has to decline the other's zone cleanly —
// a provider that answered for a zone it does not understand would either send
// the reader to the wrong place or, for rename, edit the wrong text.
//
// These run in a real Extension Host because provider coexistence is the thing
// under test, and only VS Code decides how several providers are combined.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const PAGE = [
    '<%@ Language="VBScript" %>',   // 0
    '<%',                           // 1
    '  Dim orderTotal',             // 2
    '  orderTotal = 10',            // 3
    '%>',                           // 4
    '<html>',                       // 5
    '<body>',                       // 6
    '<script>',                     // 7
    'function addRow(label) {',     // 8
    '  var total = 0;',             // 9
    '  total = total + 1;',         // 10
    '  return label + total;',      // 11
    '}',                            // 12
    '</script>',                    // 13
    '<script>',                     // 14
    'addRow("first");',             // 15
    '</script>',                    // 16
    '</body>',                      // 17
    '</html>',                      // 18
    '',
].join('\n');

// The page is written to a real .asp file rather than opened untitled: the ASP
// rename provider resolves a name's scope through the file's #include closure,
// which an untitled document has no path for.
let pageUri: vscode.Uri;

suiteSetup(async () => {
    const dir = vscode.Uri.file(os.tmpdir());
    pageUri = vscode.Uri.joinPath(dir, `asp-nav-${process.pid}.asp`);
    await vscode.workspace.fs.writeFile(pageUri, Buffer.from(PAGE, 'utf8'));
});

suiteTeardown(async () => {
    try { await vscode.workspace.fs.delete(pageUri); } catch { /* already gone */ }
});

async function openPage(): Promise<vscode.TextDocument> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument(pageUri);
    await vscode.window.showTextDocument(doc);
    await sleep(500);
    return doc;
}

/** Position of the Nth occurrence of `needle`, one character in. */
function posOf(doc: vscode.TextDocument, needle: string, n = 1): vscode.Position {
    let idx = -1;
    for (let i = 0; i < n; i++) { idx = PAGE.indexOf(needle, idx + 1); }
    assert.ok(idx >= 0, `no occurrence ${n} of ${JSON.stringify(needle)}`);
    return doc.positionAt(idx + 1);
}

suite('JavaScript navigation coexists with the ASP providers (integration)', () => {

    test('F12 on a cross-block JS call lands on its declaration', async () => {
        const doc = await openPage();
        const out = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider', doc.uri, posOf(doc, 'addRow', 2),
        );
        assert.ok(out?.length, 'expected a definition');
        assert.strictEqual(out[0].range.start.line, 8);
    });

    test('F12 still resolves a VBScript name, which the ASP provider owns', async () => {
        const doc = await openPage();
        const out = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider', doc.uri, posOf(doc, 'orderTotal', 2),
        );
        assert.ok(out?.length, 'the ASP definition provider should still answer');
        assert.strictEqual(out[0].range.start.line, 2, 'the Dim declares it');
    });

    test('Shift+F12 finds a JS symbol across <script> blocks', async () => {
        const doc = await openPage();
        const out = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider', doc.uri, posOf(doc, 'addRow', 1),
        );
        const lines = (out ?? []).map(l => l.range.start.line).sort((a, b) => a - b);
        assert.deepStrictEqual(lines, [8, 15]);
    });

    test('F2 on a JS local rewrites every use in the page', async () => {
        const doc  = await openPage();
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            'vscode.executeDocumentRenameProvider', doc.uri, posOf(doc, 'total', 1), 'runningTotal',
        );
        const edits = edit?.get(doc.uri) ?? [];
        assert.deepStrictEqual(
            edits.map(e => e.range.start.line).sort((a, b) => a - b), [9, 10, 10, 11],
        );
    });

    test('F2 still renames a VBScript name, which the ASP provider owns', async () => {
        const doc  = await openPage();
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            'vscode.executeDocumentRenameProvider', doc.uri, posOf(doc, 'orderTotal', 1), 'orderSum',
        );
        const edits = edit?.get(doc.uri) ?? [];
        assert.deepStrictEqual(
            edits.map(e => e.range.start.line).sort((a, b) => a - b), [2, 3],
            'the Dim and the assignment',
        );
    });

    test('occurrence highlighting distinguishes a JS write from its reads', async () => {
        const doc = await openPage();
        const out = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
            'vscode.executeDocumentHighlights', doc.uri, posOf(doc, 'total', 1),
        );
        assert.ok((out?.length ?? 0) >= 4, `expected every occurrence; got ${out?.length}`);
        assert.ok(
            out.some(h => h.kind === vscode.DocumentHighlightKind.Write),
            'the assignment should be a write',
        );
    });
});
