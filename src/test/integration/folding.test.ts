import * as assert from 'assert';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// VBScript blocks fold however the page is indented, and the markup still
// folds by indentation, as it did before the page had a folding provider.
suite('Folding (integration)', () => {
    teardown(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });

    test('folds VBScript blocks at the tags indent, and the markup by indentation', async () => {
        const content = [
            '<%',                      // 0
            'Sub Show(x)',             // 1
            'If x Then',               // 2
            'Response.Write x',        // 3
            'End If',                  // 4
            'End Sub',                 // 5
            '%>',                      // 6
            '<div>',                   // 7
            '    <p>a</p>',            // 8
            '</div>',                  // 9
        ].join('\n');
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
        await vscode.window.showTextDocument(doc);
        let ranges: vscode.FoldingRange[] = [];
        for (let i = 0; i < 30 && !ranges.some(r => r.start === 1); i++) {
            await sleep(200);
            ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', doc.uri) ?? [];
        }
        const spans = ranges.map(r => `${r.start}-${r.end}`);
        for (const span of ['1-4', '2-3', '7-8']) { assert.ok(spans.includes(span), `${span} in ${JSON.stringify(spans)}`); }
    });
});
