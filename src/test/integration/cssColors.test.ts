import * as assert from 'assert';
import * as vscode from 'vscode';

// The colour logic is covered by unit tests against the real CSS language
// service; what only a real Extension Host can confirm is that the provider is
// registered for this language and that VS Code accepts its ranges — a swatch
// whose range VS Code rejects simply never appears, with no error anywhere.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const PAGE = [
    '<%@ Language="VBScript" %>',
    '<html>',
    '<head>',
    '<style>',
    '  .row { color: #f9fbb7; background: rgb(255, 0, 0); }',
    '</style>',
    '</head>',
    '<body>',
    '<td style="color: #abcdef">cell</td>',
    '</body>',
    '</html>',
    '',
].join('\n');

async function open(content = PAGE): Promise<vscode.TextDocument> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    await vscode.window.showTextDocument(doc);
    await sleep(400);
    return doc;
}

suite('CSS colour swatches are offered in an ASP page (integration)', () => {

    test('every colour in the page is reported, in <style> and in style=""', async () => {
        const doc = await open();
        const out = await vscode.commands.executeCommand<vscode.ColorInformation[]>(
            'vscode.executeDocumentColorProvider', doc.uri,
        );
        const covered = (out ?? []).map(c => doc.getText(c.range)).sort();
        assert.deepStrictEqual(covered, ['#abcdef', '#f9fbb7', 'rgb(255, 0, 0)']);
    });

    test('the picker offers a replacement for a swatch', async () => {
        const doc   = await open();
        const start = PAGE.indexOf('#f9fbb7');
        const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + 7));

        const out = await vscode.commands.executeCommand<vscode.ColorPresentation[]>(
            'vscode.executeColorPresentationProvider', new vscode.Color(0, 0, 1, 1), { uri: doc.uri, range },
        );
        assert.ok(
            (out ?? []).some(p => p.label.toLowerCase() === '#0000ff'),
            `expected a hex presentation; got ${JSON.stringify((out ?? []).map(p => p.label))}`,
        );
    });

    test('a page with no CSS reports no colours', async () => {
        const doc = await open('<html>\n<body>red</body>\n</html>\n');
        const out = await vscode.commands.executeCommand<vscode.ColorInformation[]>(
            'vscode.executeDocumentColorProvider', doc.uri,
        );
        assert.deepStrictEqual(out ?? [], []);
    });
});
