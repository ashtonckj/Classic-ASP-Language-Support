import * as assert from 'assert';
import * as vscode from 'vscode';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 6000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (check()) { return true; }
        await sleep(100);
    }
    return false;
}

// The parser's checks: each is something VBScript stops at, or code that does
// nothing. They sit in the checks collection, so Format Document still runs.
const PAGE = [
    '<%',                                  // 0
    'Option Explicit',                     // 1
    'Dim total',                           // 2
    'Sub Add(n)',                          // 3
    '        Dim spare',                   // 4
    '  total = totl + n',                  // 5
    '  Exit Sub',                          // 6
    '  total = 0',                         // 7
    'End Sub',                             // 8
    'Add 1, 2',                            // 9
    '%>',                                  // 10
    '',
].join('\n');

suite('The parser checks a VBScript page (integration)', () => {

    test('flags an undeclared name, a wrong call, an unused local and unreachable code', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: PAGE });
        await vscode.window.showTextDocument(doc);

        const checks = () => vscode.languages.getDiagnostics(doc.uri).filter(d => d.source === 'Classic ASP' && d.code !== 'missing-set');
        assert.ok(await waitFor(() => checks().length >= 4), `got ${JSON.stringify(checks().map(d => d.code))}`);

        const found = checks().map(d => `${d.range.start.line} ${d.code} ${doc.getText(d.range).split('\n')[0]}`).sort();
        assert.deepStrictEqual(found, ['4 unused spare', '5 undeclared totl', '7 unreachable total = 0', '9 wrong-arguments Add']);

        const unused = checks().find(d => d.code === 'unused')!;
        assert.deepStrictEqual(unused.tags, [vscode.DiagnosticTag.Unnecessary]);

        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 4, insertSpaces: true },
        );
        // Line 4 is indented too far, so formatting changes it — unless it was refused.
        assert.ok(edits && edits.length > 0, 'Format Document should still run with these on the page');
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
});
