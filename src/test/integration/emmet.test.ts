import * as assert from 'assert';
import * as vscode from 'vscode';

// Emmet is the reason writing HTML by hand is bearable: `ul>li*3` becomes a real
// list. Two separate things carry it, and only one needs configuring:
//
//   * the explicit Expand Abbreviation command works in any language already;
//   * the abbreviation appearing in the SUGGEST WIDGET as you type — which is how
//     anyone actually reaches it, since Tab expansion is off by default — comes
//     from Emmet's completion provider, and that is only registered for
//     languages listed in `emmet.includeLanguages`.
//
// So these tests drive completion, not the command. The extension ships the
// mapping as a configuration default so a Classic ASP page behaves like the HTML
// it mostly is.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Returns the completion labels offered at the end of `line`. */
async function completionsAtEndOf(content: string, line: number): Promise<string[]> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    const editor = await vscode.window.showTextDocument(doc);
    await sleep(500);
    const pos = new vscode.Position(line, editor.document.lineAt(line).text.length);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', doc.uri, pos,
    );
    return (list?.items ?? []).map(i =>
        typeof i.label === 'string' ? i.label : i.label.label,
    );
}

/** Emmet offers the expansion itself as the completion's detail/label. */
function hasEmmetExpansion(labels: string[], abbreviation: string): boolean {
    return labels.includes(abbreviation);
}

suite('Emmet abbreviations are offered in an ASP page (integration)', () => {

    test('a nested abbreviation with a repeat is offered', async () => {
        const labels = await completionsAtEndOf('<html>\n<body>\nul>li*3\n</body>\n</html>\n', 2);
        assert.ok(
            hasEmmetExpansion(labels, 'ul>li*3'),
            `Emmet should offer the abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });

    test('a class abbreviation is offered', async () => {
        const labels = await completionsAtEndOf('<html>\n<body>\ndiv.row\n</body>\n</html>\n', 2);
        assert.ok(
            hasEmmetExpansion(labels, 'div.row'),
            `Emmet should offer the abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });

    // Inside a VBScript block `ul>li*3` is a comparison against undeclared
    // variables, not markup, so Emmet must stay out of it.
    test('an abbreviation inside a <% %> block is not offered', async () => {
        const labels = await completionsAtEndOf('<%\nul>li*3\n%>\n', 1);
        assert.ok(
            !hasEmmetExpansion(labels, 'ul>li*3'),
            `VBScript code must not be treated as an abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });
});
