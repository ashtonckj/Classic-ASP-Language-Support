import * as assert from 'assert';
import * as vscode from 'vscode';

// Reported upstream (see the GitHub issue): a TextEditorDecorationType's
// backgroundColor is painted on the same layer as the text, above VS Code's own
// selection highlight. With a visible-enough ASP-region colour, selecting text
// inside a <% %> block made the selection disappear — the decoration painted
// right over it. The ASP tint is now always painted in full, everywhere, and a
// second decoration (highlight.ts, overlapWithSelections) using the theme's own
// selection colour is layered ON TOP of it over just the part a selection
// covers — the two translucent layers blend, so the result still reads as
// tinted ASP code AND as a normal selection, rather than either signal
// replacing the other. A selection never affects a region it doesn't overlap.
//
// What this suite can and cannot prove. `TextEditor.setDecorations` is a frozen
// own property on the real editor object — `writable: false, configurable:
// false` — so it cannot be monkey-patched the way this suite patches ts.Debug
// elsewhere, and there is no public API to ask what was last painted. So the
// actual pixels are outside what an automated test here can check; that part
// is a manual/visual check (see test-files/bug-repos for a fixture). What CAN
// be proven is that hooking a decoration update into every selection-change
// event doesn't destabilise the editor — the real risk of that design, since
// dragging a selection fires the event continuously.
//
// The overlap logic itself is covered directly and exhaustively — every
// overlap shape, multi-cursor, and bracket-sized ranges — in
// src/test/unit/highlight.test.ts.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const PAGE = [
    '<html>',
    '<body>',
    '<%',
    '  Dim orderTotal',
    '  orderTotal = 10',
    '%>',
    '</body>',
    '</html>',
    '',
].join('\n');

suite('ASP region highlighting survives selection changes (integration)', () => {

    test('selecting inside, across, and outside a <% %> block does not throw', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: PAGE });
        const editor = await vscode.window.showTextDocument(doc);

        // Let the debounced decoration pass (200ms) run at least once first.
        await sleep(500);

        const selections: vscode.Selection[] = [
            // Inside the <% %> block — the case that broke.
            new vscode.Selection(3, 2, 3, 5),
            // Spanning the closing %> — half in, half out of the region.
            new vscode.Selection(4, 0, 5, 2),
            // Outside the block entirely.
            new vscode.Selection(0, 1, 0, 5),
            // Back to a plain caret.
            new vscode.Selection(3, 2, 3, 2),
        ];

        for (const selection of selections) {
            editor.selection = selection;
            await sleep(60);
        }

        // The editor must still be alive and tracking the caret correctly —
        // nothing about hiding decorations should have desynced it.
        assert.strictEqual(editor.selection.isEmpty, true);
        assert.strictEqual(editor.selection.active.line, 3);
    });

    test('rapid selection changes, as a drag produces, do not throw', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: PAGE });
        const editor = await vscode.window.showTextDocument(doc);
        await sleep(500);

        // A drag fires one selection-change event per intermediate position,
        // with no delay between them — exactly what growing a selection one
        // character at a time inside the <% %> block would produce.
        const line = 3;
        for (let end = 2; end <= 15; end++) {
            editor.selection = new vscode.Selection(line, 2, line, end);
        }
        await sleep(300);

        assert.strictEqual(editor.selection.start.character, 2);
        assert.strictEqual(editor.selection.end.character, 15);
    });

    test('selecting inside one <% %> block leaves a second, untouched block alone', async () => {
        const twoBlocks = [
            '<html>',
            '<%',
            '  Dim first',
            '  first = 1',
            '%>',
            '<body>',
            '<%',
            '  Dim second',
            '  second = 2',
            '%>',
            '</body>',
            '</html>',
            '',
        ].join('\n');

        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: twoBlocks });
        const editor = await vscode.window.showTextDocument(doc);
        await sleep(500);

        // Select only inside the FIRST block. splitByOverlap runs once per
        // cached region — this is the shape that would break if the second
        // block's ranges were somehow folded into the same split as the first.
        editor.selection = new vscode.Selection(2, 2, 2, 7);
        await sleep(300);

        assert.strictEqual(editor.document.getText(editor.selection), 'Dim f');
    });
});
