import * as assert from 'assert';
import * as vscode from 'vscode';

// Emmet reaches a Classic ASP page through ONE route: the Tab handler in
// aspIndentProvider, which checks the zone first and asks Emmet to expand using
// an explicitly named syntax. See emmetTab.test.ts for that behaviour.
//
// It deliberately does NOT reach the page through `emmet.includeLanguages`.
// That setting maps a whole language to an Emmet syntax, and Emmet reads its
// configuration with no resource and no position, so there is no way to say
// "html, but only outside <% %>". With `asp` listed there, the suggest widget
// offered abbreviations everywhere in the file, including in the middle of
// VBScript — `Response.CharSet` was offered as `<Response class="Charset">`.
//
// So the mapping is gone, and these tests hold that line: nothing in an .asp
// file should produce an Emmet completion item, least of all inside an ASP
// block. Losing the suggest-widget route is the deliberate cost; Tab still
// expands, which is how abbreviations are written anyway.

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

suite('Emmet does not reach the suggest widget in an ASP page (integration)', () => {

    test('an abbreviation in the markup is not offered as a completion', async () => {
        const labels = await completionsAtEndOf('<html>\n<body>\nul>li*3\n</body>\n</html>\n', 2);
        assert.ok(
            !hasEmmetExpansion(labels, 'ul>li*3'),
            `Emmet should not be in the suggest list; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });

    test('a class abbreviation in the markup is not offered either', async () => {
        const labels = await completionsAtEndOf('<html>\n<body>\ndiv.row\n</body>\n</html>\n', 2);
        assert.ok(
            !hasEmmetExpansion(labels, 'div.row'),
            `Emmet should not be in the suggest list; got ${JSON.stringify(labels.slice(0, 25))}`,
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

    // Reported: typing Response.CharSet inside <% %> and taking the suggestion
    // replaced it with <Response class="Charset"></Response>. Every VBScript
    // member expression has the shape of Emmet's class shorthand (tag.class), so
    // this is not one unlucky identifier — Request.Form, Session.Timeout and
    // anything else written with a dot are all abbreviations as far as Emmet is
    // concerned.
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
});

suite('The extension still completes ASP intrinsics (integration)', () => {

    // The mapping being gone must not have taken the extension's own
    // completions with it — these come from ASP_OBJECTS, not from Emmet.
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
