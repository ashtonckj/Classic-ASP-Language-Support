import * as assert from 'assert';
import * as vscode from 'vscode';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function completionsAtEndOf(content: string, line: number): Promise<vscode.CompletionItem[]> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    const editor = await vscode.window.showTextDocument(doc);
    await sleep(500);
    const position = new vscode.Position(line, editor.document.lineAt(line).text.length);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', doc.uri, position,
    );
    return list?.items ?? [];
}

const labelOf = (item: vscode.CompletionItem) =>
    typeof item.label === 'string' ? item.label : item.label.label;

// A `.` with no name before it, inside `With rs … End With`, means rs. It used
// to pop up the whole keyword and function list — Abs, Array, Asc… — and none
// of the Recordset's own members.
suite('Members of a With block are offered after a bare dot (integration)', () => {

    const labelsAt = async (content: string, line: number) => (await completionsAtEndOf(content, line)).map(labelOf);

    test("a Recordset's members, and nothing else", async () => {
        const labels = await labelsAt('<%\nSet rs = Server.CreateObject("ADODB.Recordset")\nWith rs\n  .\nEnd With\n%>\n', 3);
        assert.ok(labels.includes('EOF') && labels.includes('MoveNext'), `got ${JSON.stringify(labels.slice(0, 25))}`);
        assert.ok(!labels.includes('Abs') && !labels.includes('Response'), 'keywords and functions do not follow a dot');
    });

    test('an intrinsic object, and an object created in the With itself', async () => {
        assert.ok((await labelsAt('<%\nWith Response\n  .\nEnd With\n%>\n', 2)).includes('Write'));
        const dict = await labelsAt('<%\nWith Server.CreateObject("Scripting.Dictionary")\n  .\nEnd With\n%>\n', 2);
        assert.ok(dict.includes('Exists'), `got ${JSON.stringify(dict.slice(0, 25))}`);
    });

    test('nothing after a bare dot outside a With block, or on an object of unknown type', async () => {
        assert.deepStrictEqual(await labelsAt('<%\nx = .\n%>\n', 1), []);
        assert.deepStrictEqual(await labelsAt('<%\nWith thing\n  .\nEnd With\n%>\n', 2), []);
    });
});
