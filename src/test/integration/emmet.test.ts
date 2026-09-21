import * as assert from 'assert';
import * as vscode from 'vscode';

// Emmet should behave in a Classic ASP page the way it does in a .html file:
// the abbreviation appears in the suggest widget as you type, and Enter or Tab
// accepts it. That comes from Emmet's own completion provider, which is only
// registered for languages listed in `emmet.includeLanguages` — so the
// extension ships `asp: html` as a configuration default.
//
// The part that has to be different is VBScript. Inside <% %>, `ul>li*3` is a
// comparison between undeclared variables and `Response.CharSet` is a property
// of a built-in object, and neither is markup.
//
// Emmet's mapping is per LANGUAGE, with no notion of where the caret is, so the
// extension cannot tell it to skip those regions. What does the work is Emmet's
// own HTML parser: `<% … %>` looks like an ordinary tag to it — `<`, a name,
// then `>` — and Emmet refuses to expand inside a tag, for the same reason it
// refuses inside `<div class="…">`. These tests hold that line, since it is
// relied on rather than controlled.

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

/** Emmet offers the expansion itself as the completion's label. */
function hasEmmetExpansion(labels: string[], abbreviation: string): boolean {
    return labels.includes(abbreviation);
}

suite('Emmet abbreviations are offered in the markup (integration)', () => {

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
});

suite('Emmet stays out of VBScript (integration)', () => {

    test('an abbreviation inside a <% %> block is not offered', async () => {
        const labels = await completionsAtEndOf('<%\nul>li*3\n%>\n', 1);
        assert.ok(
            !hasEmmetExpansion(labels, 'ul>li*3'),
            `VBScript code must not be treated as an abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });

    // Reported: typing Response.CharSet inside <% %> and taking the suggestion
    // replaced it with <Response class="Charset"></Response>. Every VBScript
    // member expression has the shape of Emmet's class shorthand (tag.class), so
    // this is not one unlucky identifier — Request.Form, Session.Timeout and
    // anything else written with a dot look the same to Emmet.
    test('a VBScript member expression inside <% %> is not offered', async () => {
        const labels = await completionsAtEndOf('<%\nResponse.CharSet\n%>\n', 1);
        assert.ok(
            !hasEmmetExpansion(labels, 'Response.CharSet'),
            `VBScript code must not be treated as an abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });

    test('a VBScript member expression inside <%= %> is not offered', async () => {
        const labels = await completionsAtEndOf('<p><%= Request.Form %></p>\n', 0);
        assert.ok(
            !hasEmmetExpansion(labels, 'Request.Form'),
            `VBScript code must not be treated as an abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });

    test('an indented statement inside a multi-line block is not offered', async () => {
        const labels = await completionsAtEndOf(
            '<html>\n<body>\n<%\n    If x Then\n        Session.Timeout\n    End If\n%>\n</body>\n</html>\n', 4);
        assert.ok(
            !hasEmmetExpansion(labels, 'Session.Timeout'),
            `VBScript code must not be treated as an abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });
});

suite('The extension still completes ASP intrinsics (integration)', () => {

    // These come from ASP_OBJECTS, not from Emmet, and must survive whatever
    // Emmet is or is not doing in the same position.
    test('Response. offers its members, including ones beyond Write', async () => {
        const labels = await completionsAtEndOf('<%\nResponse.\n%>\n', 1);
        for (const member of ['Write', 'Charset', 'ContentType', 'Status', 'Buffer']) {
            assert.ok(
                labels.includes(member),
                `Response.${member} should be offered; got ${JSON.stringify(labels.slice(0, 25))}`,
            );
        }
    });

    test('Server. offers Transfer and Execute', async () => {
        const labels = await completionsAtEndOf('<%\nServer.\n%>\n', 1);
        for (const member of ['CreateObject', 'MapPath', 'Transfer', 'Execute']) {
            assert.ok(
                labels.includes(member),
                `Server.${member} should be offered; got ${JSON.stringify(labels.slice(0, 25))}`,
            );
        }
    });

    test('ASPError. offers its members, an object that was missing entirely', async () => {
        const labels = await completionsAtEndOf('<%\nASPError.\n%>\n', 1);
        for (const member of ['Number', 'Description', 'File', 'Line']) {
            assert.ok(
                labels.includes(member),
                `ASPError.${member} should be offered; got ${JSON.stringify(labels.slice(0, 25))}`,
            );
        }
    });
});
