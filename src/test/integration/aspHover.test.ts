import * as assert from 'assert';
import * as vscode from 'vscode';

// Hover found a declaration by its name alone, so a parameter showed the page
// variable of the same name, and `obj.total` showed the variable `total`. It now
// asks the parser which declaration the name means.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function hoverTextAt(content: string, line: number, word: string): Promise<string> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    await vscode.window.showTextDocument(doc);
    await sleep(300);
    const character = doc.lineAt(line).text.indexOf(word) + 1;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', doc.uri, new vscode.Position(line, character),
    );
    return (hovers ?? [])
        .flatMap(h => h.contents)
        .map(c => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
        .join('\n');
}

const PAGE = [
    '<%',
    'Dim total',
    'Sub Report(total)',
    '  Response.Write total',
    'End Sub',
    'x = order.total',
    'Set rs = Server.CreateObject("ADODB.Recordset")',
    'With rs',
    '  x = .EOF',
    'End With',
    '%>',
    '',
].join('\n');

suite('Hover on VBScript names (integration)', () => {

    test('a parameter is the parameter, not the page variable of that name', async () => {
        const text = await hoverTextAt(PAGE, 3, 'total');
        assert.strictEqual(text, '**total** — parameter of `Report`');
    });

    test('a member of another object is not the variable of that name', async () => {
        const text = await hoverTextAt(PAGE, 5, 'total');
        assert.ok(!text.includes('variable'), `got ${JSON.stringify(text)}`);
    });

    test('a bare .EOF inside With rs is explained as the Recordset member', async () => {
        const text = await hoverTextAt(PAGE, 8, 'EOF');
        assert.ok(/EOF/.test(text) && !text.includes('keyword'), `got ${JSON.stringify(text)}`);
    });

    test('a word in a comment or a string is text, with no hover', async () => {
        const page = '<%\nDim total\n\' uses Split on total\nx = "Split total"\n%>\n';
        assert.strictEqual(await hoverTextAt(page, 2, 'Split'), '');
        assert.strictEqual(await hoverTextAt(page, 2, 'total'), '');
        assert.strictEqual(await hoverTextAt(page, 3, 'Split'), '');
    });
});
