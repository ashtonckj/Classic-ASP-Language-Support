import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// A typical global.asa: objects declared with tags, and the event Subs in a
// server-side VBScript <script> block — no <% %> anywhere.
const GLOBAL_ASA = [
    '<object runat="Server" scope="Application" id="AppDict" progid="Scripting.Dictionary"></object>',   // 0
    '<object runat="Server" scope="Session" id="UserCart" progid="Scripting.Dictionary"></object>',      // 1
    '',                                                                                                  // 2
    '<script language="VBScript" runat="Server">',                                                       // 3
    'Option Explicit',                                                                                   // 4
    '',                                                                                                  // 5
    'Sub Application_OnStart',                                                                           // 6
    '      Application("Visitors") = 0',                                                                 // 7
    '    AppDict.Add "started", Now()',                                                                  // 8
    'End Sub',                                                                                           // 9
    '',                                                                                                  // 10
    'Sub Session_OnStart',                                                                               // 11
    '    Dim count',                                                                                     // 12
    '    count = Application("Visitors") + 1',                                                           // 13
    '    Application("Visitors") = count',                                                               // 14
    '    UserCart.Add "created", Now()',                                                                 // 15
    'End Sub',                                                                                           // 16
    '',                                                                                                  // 17
    'Sub Session_OnEnd',                                                                                 // 18
    '    Application("Visitors") = Application("Visitors") - 1',                                         // 19
    'End Sub',                                                                                           // 20
    '</script>',                                                                                         // 21
    '',
].join('\n');

suite('global.asa (integration)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-global-asa-'));
    const file = path.join(dir, 'global.asa');
    let doc: vscode.TextDocument;

    suiteSetup(async () => {
        fs.writeFileSync(file, GLOBAL_ASA);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('opens as Classic ASP', () => {
        assert.strictEqual(doc.languageId, 'asp');
    });

    test('raises no warning or error of this extension', async () => {
        // The structure warnings and the checks run a moment after the page opens.
        await sleep(3000);
        const ours = vscode.languages.getDiagnostics(doc.uri).filter(d => String(d.source).startsWith('Classic ASP'));
        assert.deepStrictEqual(ours.map(d => `${d.range.start.line}: ${d.message}`), []);
    });

    test('lists the event Subs in the Outline', async () => {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
        const names = (symbols ?? []).map(s => s.name);
        for (const sub of ['Application_OnStart', 'Session_OnStart', 'Session_OnEnd']) {
            assert.ok(names.includes(sub), `${sub} missing from ${JSON.stringify(names)}`);
        }
    });

    test('offers the members of an object an <object> tag declares', async () => {
        const position = new vscode.Position(8, '    AppDict.'.length);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, position, '.');
        const labels = list.items.map(i => typeof i.label === 'string' ? i.label : i.label.label);
        assert.ok(labels.includes('Exists') && labels.includes('Add'), JSON.stringify(labels.slice(0, 20)));
    });

    test('formats, with the VBScript indented inside its <script> tag', async () => {
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 2, insertSpaces: true },
        );
        assert.ok(edits && edits.length > 0, 'Format Document should run on a global.asa');
        const edit = new vscode.WorkspaceEdit();
        edit.set(doc.uri, edits);
        await vscode.workspace.applyEdit(edit);
        const lines = doc.getText().split(/\r?\n/);
        assert.ok(lines.includes('  Sub Application_OnStart'), doc.getText());
        assert.ok(lines.includes('    Application("Visitors") = 0'), doc.getText());
        assert.ok(!doc.getText().includes(';'), 'no JavaScript semicolons');
    });
});
