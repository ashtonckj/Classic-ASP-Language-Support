import * as assert from 'assert';
import * as vscode from 'vscode';

// Emmet should behave in a Classic ASP page the way it does in a .html file:
// the abbreviation appears in the suggest widget as you type, and Enter or Tab
// accepts it.
//
// The part that has to be different is VBScript. Inside <% %>, `ul>li*3` is a
// comparison between undeclared variables and `Response.CharSet` is a property
// of a built-in object, and neither is markup.
//
// The obvious route — `emmet.includeLanguages` mapping `asp` to `html` — cannot
// make that distinction, because the mapping is per LANGUAGE and Emmet's own
// provider has no notion of where in the page the caret is. What appears to
// save it is a heuristic inside Emmet: from the caret it scans back at most 500
// characters, and a `<` found first means "inside a tag, refuse" while a `>`
// found first means "after a tag, go ahead". A bare `<% … %>` trips the `<`
// rule, so the simple cases behave — but it is not a rule about ASP, and one
// suite below records the ordinary VBScript that walks straight through it.
//
// So the mapping is left unset and the expansions come from this extension's
// own EmmetCompletionProvider, which asks `getZone` where the caret is.

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

// Each of these was measured OFFERING an expansion inside <% %> while Emmet's
// own provider was serving the page, and each is ordinary VBScript rather than
// a contrived edge. They share one cause: scanning back from the caret finds a
// `>` before it finds the `<` of the block, so Emmet concludes it is sitting in
// markup after a closed tag. The last case has no `>` at all and gets there a
// different way — the block is longer than the 500 characters Emmet looks back
// over, so the `<%` is simply out of view.
suite("VBScript that Emmet's own guard lets through (integration)", () => {

    const cases: ReadonlyArray<[name: string, page: string, line: number, code: string]> = [
        ['a greater-than comparison',
            '<%\nIf x > 0 Then\nResponse.CharSet\n%>\n', 2, 'Response.CharSet'],
        ['a greater-than-or-equal comparison',
            '<%\nIf x >= 0 Then\nResponse.CharSet\n%>\n', 2, 'Response.CharSet'],
        ['a not-equal comparison',
            '<%\nIf x <> 0 Then\nResponse.CharSet\n%>\n', 2, 'Response.CharSet'],
        ['a tag emitted from a string',
            '<%\nResponse.Write "<div>"\nResponse.CharSet\n%>\n', 2, 'Response.CharSet'],
        ['an arrow drawn in a comment',
            "<%\n' arrow -> here\nResponse.CharSet\n%>\n", 2, 'Response.CharSet'],
        ['an abbreviation inside a block nested in markup',
            '<html>\n<body>\n<%\nIf x > 0 Then\nul>li*3\n%>\n</body>\n</html>\n', 4, 'ul>li*3'],
        ['a block longer than the window Emmet looks back over',
            '<%\n' + Array.from({ length: 40 }, (_, i) => `Dim variableNumber${i}`).join('\n')
                + '\nResponse.CharSet\n%>\n', 41, 'Response.CharSet'],
    ];

    for (const [name, page, line, code] of cases) {
        test(name, async () => {
            const labels = await completionsAtEndOf(page, line);
            assert.ok(
                !hasEmmetExpansion(labels, code),
                `VBScript code must not be treated as an abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
            );
        });
    }
});

// The other half of the bargain: taking the decision away from Emmet must not
// cost anything the mapping gave. A stylesheet abbreviation is labelled with
// what it expands TO rather than with the abbreviation, so `m10` is looked up
// as `margin: 10px;`.
suite('The markup and stylesheet zones still expand (integration)', () => {

    test('a stylesheet abbreviation inside <style> is offered', async () => {
        const labels = await completionsAtEndOf(
            '<html>\n<style>\n.a {\n  m10\n}\n</style>\n</html>\n', 3);
        assert.ok(
            labels.includes('margin: 10px;'),
            `m10 should expand to margin: 10px;, got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });

    test('markup after a closing %> is offered', async () => {
        const labels = await completionsAtEndOf('<%\nx = 1\n%>\nul>li*3\n', 3);
        assert.ok(
            hasEmmetExpansion(labels, 'ul>li*3'),
            `Emmet should offer the abbreviation; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });

    // Two providers offering the same expansion would show the abbreviation
    // twice in the widget — the symptom if `emmet.includeLanguages` ever comes
    // back while this extension's own provider is registered.
    test('the expansion is offered exactly once', async () => {
        const labels = await completionsAtEndOf('<html>\n<body>\nul>li*3\n</body>\n</html>\n', 2);
        assert.strictEqual(
            labels.filter(l => l === 'ul>li*3').length, 1,
            `expected one ul>li*3 item; got ${JSON.stringify(labels.slice(0, 25))}`,
        );
    });
});
