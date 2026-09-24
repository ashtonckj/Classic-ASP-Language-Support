import * as assert from 'assert';
import * as vscode from 'vscode';

// In a .html file VS Code explains a tag or attribute on hover and offers the
// values an attribute takes. A page had neither; it now runs the same HTML
// language service over the page's markup.

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

const labelOf = (item: vscode.CompletionItem) => (typeof item.label === 'string' ? item.label : item.label.label);

suite('HTML hovers and attribute values (integration)', () => {

    test('a tag and an attribute explain themselves, with ASP around them', async () => {
        const doc = await open('<% x = 1 %>\n<div class="<%= cls %>">text</div>\n');
        assert.ok((await hoverText(doc, new vscode.Position(1, 2))).includes('no special meaning'), 'the div tag should be explained');
        assert.ok((await hoverText(doc, new vscode.Position(1, 6))).toLowerCase().includes('classes'), 'the class attribute should be explained');
    });

    test('no HTML hover inside the VBScript', async () => {
        const doc = await open('<%\nDim div\n%>\n');
        assert.ok(!(await hoverText(doc, new vscode.Position(1, 5))).includes('no special meaning'));
    });

    test("an attribute's values are offered inside its quotes", async () => {
        const doc = await open('<input type="">\n');
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 13),
        );
        const labels = (list?.items ?? []).map(labelOf);
        assert.ok(labels.includes('checkbox') && labels.includes('hidden'), `got ${JSON.stringify(labels.slice(0, 25))}`);
    });

    test('picking an attribute with known values goes on to offer them', async () => {
        const doc = await open('<input >\n');
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 7), ' ',
        );
        const type = list?.items.find(item => labelOf(item) === 'type');
        assert.strictEqual(type?.command?.command, 'editor.action.triggerSuggest');
    });
});
