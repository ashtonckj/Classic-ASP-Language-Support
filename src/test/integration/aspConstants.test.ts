import * as assert from 'assert';
import * as vscode from 'vscode';

// VBScript's constants were in the grammar, so `vbCrLf` had always COLOURED as
// part of the language — but nothing offered it, because the completion
// provider only knew about objects, keywords and functions. Writing the one a
// page uses most, `s & vbCrLf`, meant typing it out and hoping.
//
// They are their own kind of thing: not functions, so no call parentheses, and
// not keywords either, since a page writes one as an ordinary value.

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

suite('VBScript constants are offered inside <% %> (integration)', () => {

    test('the string constants a page actually writes are offered', async () => {
        const labels = (await completionsAtEndOf('<%\nDim s\ns = "a" & vb\n%>\n', 2)).map(labelOf);
        for (const name of ['vbCrLf', 'vbTab', 'vbNewLine', 'vbNullString']) {
            assert.ok(labels.includes(name), `${name} should be offered; got ${JSON.stringify(labels.slice(0, 25))}`);
        }
    });

    test('the comparison and VarType families are offered', async () => {
        const labels = (await completionsAtEndOf('<%\nIf VarType(x) = vb\n%>\n', 1)).map(labelOf);
        for (const name of ['vbTextCompare', 'vbBinaryCompare', 'vbString', 'vbObjectError']) {
            assert.ok(labels.includes(name), `${name} should be offered; got ${JSON.stringify(labels.slice(0, 25))}`);
        }
    });

    test('a constant carries its documentation and inserts no parentheses', async () => {
        const items = await completionsAtEndOf('<%\ns = vb\n%>\n', 1);
        const crlf = items.find(item => labelOf(item) === 'vbCrLf');
        assert.ok(crlf, 'vbCrLf should be offered');
        assert.strictEqual(crlf.kind, vscode.CompletionItemKind.Constant);
        assert.ok(crlf.documentation, 'vbCrLf should carry its documentation');
        // A function completion inserts `Name($0)`; a constant is a value.
        assert.ok(
            crlf.insertText === undefined || !String(crlf.insertText).includes('('),
            'a constant must not insert call parentheses',
        );
    });

    test('nothing is offered in the markup, where a constant means nothing', async () => {
        const labels = (await completionsAtEndOf('<html>\n<body>\nvb\n</body>\n</html>\n', 2)).map(labelOf);
        assert.ok(
            !labels.includes('vbCrLf'),
            `vbCrLf is VBScript, not markup; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });
});

// Their docs were only reachable through completion: hovering `vbCrLf` already in
// a page, or `Response` itself, showed nothing, though the data was all there.
suite('Hover explains built-in constants and intrinsic objects (integration)', () => {

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

    test('a constant shows what it stands for', async () => {
        const text = await hoverTextAt('<%\nDim s\ns = "a" & vbCrLf\n%>\n', 2, 'vbCrLf');
        assert.ok(/\*\*vbCrLf\*\* — VBScript constant/.test(text), `got ${JSON.stringify(text)}`);
        assert.ok(text.includes('Chr(13) & Chr(10)'), `got ${JSON.stringify(text)}`);
    });

    test('an intrinsic object shows what it is for and what it has', async () => {
        const text = await hoverTextAt('<%\nResponse.Write "x"\n%>\n', 1, 'Response');
        assert.ok(/\*\*Response\*\* — ASP intrinsic object/.test(text), `got ${JSON.stringify(text)}`);
        assert.ok(text.includes('`Write`') && text.includes('`Buffer`'), `got ${JSON.stringify(text)}`);
    });

    test('Request lists its collections', async () => {
        const text = await hoverTextAt('<%\nx = Request.Form("a")\n%>\n', 1, 'Request');
        assert.ok(/\*\*Collections:\*\* .*`Form`/.test(text), `got ${JSON.stringify(text)}`);
    });

    test('a member is still explained as the member, not the object', async () => {
        const text = await hoverTextAt('<%\nResponse.Write "x"\n%>\n', 1, 'Write');
        assert.ok(text.includes('Response.Write') && !text.includes('ASP intrinsic object'), `got ${JSON.stringify(text)}`);
    });
});
