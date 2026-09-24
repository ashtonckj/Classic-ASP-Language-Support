import * as assert from 'assert';
import * as vscode from 'vscode';

// In a .html file VS Code explains a tag or attribute on hover. A page had
// nothing; it now runs the same HTML language service over the page's markup.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function open(content: string): Promise<vscode.TextDocument> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    await vscode.window.showTextDocument(doc);
    await sleep(300);
    return doc;
}

async function hoverText(doc: vscode.TextDocument, position: vscode.Position): Promise<string> {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
    return (hovers ?? [])
        .flatMap(h => h.contents)
        .map(c => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
        .join('\n');
}

suite('HTML hovers (integration)', () => {

    test('a tag and an attribute explain themselves, with ASP around them', async () => {
        const doc = await open('<% x = 1 %>\n<div class="<%= cls %>">text</div>\n');
        assert.ok((await hoverText(doc, new vscode.Position(1, 2))).includes('no special meaning'), 'the div tag should be explained');
        assert.ok((await hoverText(doc, new vscode.Position(1, 6))).toLowerCase().includes('classes'), 'the class attribute should be explained');
    });

    test('no HTML hover inside the VBScript', async () => {
        const doc = await open('<%\nDim div\n%>\n');
        assert.ok(!(await hoverText(doc, new vscode.Position(1, 5))).includes('no special meaning'));
    });

});
