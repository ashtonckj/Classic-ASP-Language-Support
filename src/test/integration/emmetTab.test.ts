import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';

// Tab is bound to `asp.insertTab` for .asp files, so everything Tab would
// otherwise do has to be done by that command. Emmet's Tab expansion is one of
// those things: `ul>li*3` and Tab should become a real list. The keybinding
// swallowed it, because the handler fell straight through to the native `tab`
// command on any non-blank line, and that command knows nothing about
// abbreviations.
//
// Three things are covered, and the first is the one that matters most:
//
//   * an abbreviation is reachable with NOTHING configured, exactly as in a
//     .html file — via the suggest widget, which is how anyone actually reaches
//     it. `emmet.triggerExpansionOnTab` is a separate, older route.
//
//   * Tab expands too, with the setting off, but only for a token carrying an
//     unmistakable abbreviation marker (`>` `+` `^` `*`, or the .class/#id
//     shorthand). A plain word must NOT expand: an ASP page is mostly HTML body
//     text, and `Total` turning into `<Total></Total>` is the reason VS Code
//     ships that setting off in the first place.
//
//   * with the setting on, every word is a candidate — VS Code's own behaviour —
//     which is what makes bare CSS abbreviations like `m10` work.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Every document here is a REAL .asp file on disk, not an untitled buffer.
// The two are not interchangeable in this extension — the ASP rename provider
// resolves a name's scope through a file's #include closure and gets nothing
// from an untitled document — so a test that only ever exercises an untitled
// buffer is not proving anything about the file a person actually edits.
const written: vscode.Uri[] = [];
let counter = 0;

async function writeAspFile(content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(
        vscode.Uri.file(os.tmpdir()), `asp-emmet-${process.pid}-${counter++}.asp`,
    );
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    written.push(uri);
    return uri;
}

suiteTeardown(async () => {
    for (const uri of written) {
        try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ }
    }
});

async function openAspFile(content: string): Promise<vscode.TextEditor> {
    // Revert before closing: these tests leave the buffer dirty, and closing a
    // dirty editor puts a save dialog in front of the run.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    const doc = await vscode.workspace.openTextDocument(await writeAspFile(content));
    const editor = await vscode.window.showTextDocument(doc);
    await sleep(500);
    return editor;
}

/** Puts the caret at the end of `line`, presses Tab, returns the whole page. */
async function pressTab(content: string, line: number, column?: number): Promise<string> {
    const editor = await openAspFile(content);
    const col = column ?? editor.document.lineAt(line).text.length;
    editor.selection = new vscode.Selection(line, col, line, col);

    // What the Tab key is actually bound to for this language.
    await vscode.commands.executeCommand('asp.insertTab');
    for (let waited = 0; waited < 2000; waited += 50) {
        if (editor.document.getText() !== content) { break; }
        await sleep(50);
    }
    return editor.document.getText();
}

const emmet = () => vscode.workspace.getConfiguration('emmet');

async function setTriggerOnTab(value: boolean | undefined): Promise<void> {
    await emmet().update('triggerExpansionOnTab', value, vscode.ConfigurationTarget.Global);
    await sleep(300);
}

suite('Emmet abbreviations need no setting at all (integration)', () => {
    let previous: boolean | undefined;

    suiteSetup(async () => {
        previous = emmet().get<boolean>('triggerExpansionOnTab');
        await setTriggerOnTab(false);
    });

    suiteTeardown(async () => { await setTriggerOnTab(previous); });

    // The suggest-widget route: Emmet contributes the expansion as a completion
    // item, and Tab or Enter accepts it. This is what a .html file does, and it
    // is why `emmet.triggerExpansionOnTab` is not required for any of this.
    // The suggest-widget route: Emmet contributes the expansion as a completion
    // item, and Tab or Enter accepts it. This is what a .html file does, and it
    // is why `emmet.triggerExpansionOnTab` is not required for any of this.
    test('the abbreviation is offered as a completion while typing', async () => {
        const editor = await openAspFile(
            ['<html>', '<body>', '', '</body>', '</html>', ''].join('\n'),
        );
        const doc = editor.document;
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        for (const ch of 'ul>li*3') {
            await vscode.commands.executeCommand('type', { text: ch });
            await sleep(40);
        }
        await sleep(400);

        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', doc.uri, editor.selection.active,
        );
        const labels = (list?.items ?? []).map(i =>
            typeof i.label === 'string' ? i.label : i.label.label,
        );
        assert.ok(
            labels.includes('ul>li*3'),
            `Emmet should offer the expansion; got ${JSON.stringify(labels.slice(0, 10))}`,
        );
    });

    // Enter is what a .html file expands with, because Enter accepts the
    // selected suggestion. The extension's own Enter handler stands aside while
    // the widget is visible (`!suggestWidgetVisible` on the keybinding), so the
    // editor's accept wins — this checks that is still true with the ASP
    // keybindings in place.
    test('Enter accepts the suggestion and expands, as in a .html file', async () => {
        const editor = await openAspFile(
            ['<html>', '<body>', '', '</body>', '</html>', ''].join('\n'),
        );
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        for (const ch of 'ul>li*3') {
            await vscode.commands.executeCommand('type', { text: ch });
            await sleep(40);
        }
        await sleep(600);

        await vscode.commands.executeCommand('editor.action.triggerSuggest');
        await sleep(800);
        await vscode.commands.executeCommand('acceptSelectedSuggestion');
        await sleep(500);

        const out = editor.document.getText();
        assert.ok(!out.includes('ul>li*3'), `the abbreviation should be gone; got:\n${out}`);
        assert.strictEqual((out.match(/<li>/g) ?? []).length, 3, `expected three <li>; got:\n${out}`);
    });

    // Emmet is a built-in extension, so a user can disable it, and then the
    // command rejects. Tab must still be a Tab rather than raising an error and
    // inserting nothing. Inside <script> the handler never calls Emmet, which is
    // the same fall-through a rejected invocation takes.
    test('Tab still inserts an indent where Emmet is not consulted', async () => {
        const before = ['<script>', 'var x = 1;', '</script>', ''].join('\n');
        const out = await pressTab(before, 1);
        assert.notStrictEqual(out, before, 'Tab should have inserted an indent');
        assert.ok(out.includes('var x = 1;'), `the code should survive; got:\n${out}`);
    });
});

suite('Emmet expands on Tab without the global setting (integration)', () => {
    let previous: boolean | undefined;

    suiteSetup(async () => {
        previous = emmet().get<boolean>('triggerExpansionOnTab');
        // Explicitly OFF — this suite is about the default experience.
        await setTriggerOnTab(false);
    });

    suiteTeardown(async () => { await setTriggerOnTab(previous); });

    test('a nested abbreviation with a repeat expands', async () => {
        const out = await pressTab('<html>\n<body>\nul>li*3\n</body>\n</html>\n', 2);
        assert.ok(!out.includes('ul>li*3'), `the abbreviation should be gone; got:\n${out}`);
        assert.strictEqual((out.match(/<li>/g) ?? []).length, 3, `expected three <li>; got:\n${out}`);
    });

    test('a class shorthand expands', async () => {
        const out = await pressTab('<html>\n<body>\ndiv.row\n</body>\n</html>\n', 2);
        assert.ok(/<div class="row">/.test(out), `expected <div class="row">; got:\n${out}`);
    });

    test('an id shorthand expands', async () => {
        const out = await pressTab('<html>\n<body>\ndiv#main\n</body>\n</html>\n', 2);
        assert.ok(/<div id="main">/.test(out), `expected <div id="main">; got:\n${out}`);
    });

    test('a sibling abbreviation expands', async () => {
        const out = await pressTab('<html>\n<body>\ntr>td*2\n</body>\n</html>\n', 2);
        assert.strictEqual((out.match(/<td>/g) ?? []).length, 2, `expected two <td>; got:\n${out}`);
    });

    // The point of the marker requirement: body text must survive Tab.
    test('a plain word is NOT expanded, and Tab still indents', async () => {
        const out = await pressTab('<html>\n<body>\nTotal\n</body>\n</html>\n', 2);
        assert.ok(out.includes('Total'), `the word should survive; got:\n${out}`);
        assert.ok(!/<Total>/.test(out), `a plain word must not become a tag; got:\n${out}`);
    });

    test('a word ending in a full stop is NOT expanded', async () => {
        const out = await pressTab('<html>\n<body>\nDone.\n</body>\n</html>\n', 2);
        assert.ok(!/<Done/.test(out), `prose must not become a tag; got:\n${out}`);
    });

    // Inside <% %> this is a comparison against undeclared variables, not markup.
    test('an abbreviation inside a <% %> block is left alone', async () => {
        const out = await pressTab('<%\nul>li*3\n%>\n', 1);
        assert.ok(
            out.includes('ul>li*3'),
            `VBScript must not be expanded as an abbreviation; got:\n${out}`,
        );
    });

    // Reported: Response.CharSet inside <% %> became
    // <Response class="Charset"></Response>. Every VBScript member expression has
    // the shape of Emmet's class shorthand, so this covers Request.Form,
    // Session.Timeout and anything else written with a dot — the whole language.
    test('a VBScript member expression inside <% %> is left alone', async () => {
        const out = await pressTab('<%\nResponse.CharSet\n%>\n', 1);
        assert.ok(
            out.includes('Response.CharSet'),
            `VBScript must not be expanded as an abbreviation; got:\n${out}`,
        );
        assert.ok(!/<Response/.test(out), `VBScript became markup; got:\n${out}`);
    });

    test('a VBScript member expression on one line with the tags is left alone', async () => {
        const out = await pressTab('<% Response.CharSet %>\n', 0, 18);
        assert.ok(!/<Response/.test(out), `VBScript became markup; got:\n${out}`);
    });

    test('a VBScript member expression in an unterminated block is left alone', async () => {
        const out = await pressTab('<html>\n<body>\n<%\nResponse.CharSet\n', 3);
        assert.ok(!/<Response/.test(out), `VBScript became markup; got:\n${out}`);
    });

    test('a VBScript member expression inside <%= %> is left alone', async () => {
        const out = await pressTab('<p><%= Request.Form %></p>\n', 0, 19);
        assert.ok(!/<Request/.test(out), `VBScript became markup; got:\n${out}`);
    });

    // ASP finds `%>` lexically, before VBScript sees the text, so a `%>` inside a
    // string closes the block — zoneUtils.test.ts pins that against a live engine.
    // Everything after it is therefore an HTML zone, and the zone check that
    // normally keeps Emmet away from VBScript does not apply. What stops the next
    // line being rewritten as markup is the abbreviation shape alone.
    test('VBScript after a block closed by an in-string %> is left alone', async () => {
        const out = await pressTab('<%\ns = "%>"\nResponse.CharSet\n%>\n', 2);
        assert.ok(!/<Response/.test(out), `VBScript became markup; got:\n${out}`);
        assert.ok(out.includes('Response.CharSet'), `the code should survive; got:\n${out}`);
    });

    test('VBScript in a plain HTML zone is still not an abbreviation', async () => {
        const out = await pressTab('<html>\n<body>\nRequest.Form\n</body>\n</html>\n', 2);
        assert.ok(!/<Request/.test(out), `VBScript became markup; got:\n${out}`);
    });

    // The route the report actually describes: not Tab against static text, but
    // typing, the suggest widget appearing, and taking what it offered. Querying
    // the providers directly is not the same thing — the widget asks with a
    // trigger kind and character, and accepting runs the item's own insert and
    // command. So this types the identifier one key at a time and accepts
    // whatever comes up.
    test('accepting a suggestion after typing VBScript does not produce markup', async () => {
        const editor = await openAspFile('<html>\n<body>\n<%\n\n%>\n</body>\n</html>\n');
        editor.selection = new vscode.Selection(3, 0, 3, 0);

        for (const ch of 'Response.CharSet') {
            await vscode.commands.executeCommand('type', { text: ch });
            await sleep(40);
        }
        await sleep(500);

        await vscode.commands.executeCommand('editor.action.triggerSuggest');
        await sleep(800);
        await vscode.commands.executeCommand('acceptSelectedSuggestion');
        await sleep(500);

        const out = editor.document.getText();
        assert.ok(!/<Response/.test(out), `VBScript became markup; got:\n${out}`);
        assert.ok(!/class="Charset"/i.test(out), `VBScript became markup; got:\n${out}`);
    });

    // A bare CSS abbreviation has no marker and is indistinguishable from a
    // word, so on Tab it needs the setting. Pinned so it is not a surprise —
    // the suggest widget still offers it either way.
    test('a bare CSS abbreviation is left for the setting to enable', async () => {
        const out = await pressTab('<style>\n.a {\n  m10\n}\n</style>\n', 2);
        assert.ok(out.includes('m10'), `expected m10 untouched; got:\n${out}`);
    });
});

suite('Emmet expands on Tab with the global setting on (integration)', () => {
    let previous: boolean | undefined;

    suiteSetup(async () => {
        previous = emmet().get<boolean>('triggerExpansionOnTab');
        await setTriggerOnTab(true);
    });

    suiteTeardown(async () => { await setTriggerOnTab(previous); });

    test('a bare CSS abbreviation expands inside a <style> block', async () => {
        const out = await pressTab('<style>\n.a {\n  m10\n}\n</style>\n', 2);
        assert.ok(/margin:\s*10px/.test(out), `expected a margin declaration; got:\n${out}`);
    });

    test('a bare tag name expands, which is what the setting asks for', async () => {
        const out = await pressTab('<html>\n<body>\nsection\n</body>\n</html>\n', 2);
        assert.ok(/<section>/.test(out), `expected <section>; got:\n${out}`);
    });

    test('a marked abbreviation still expands', async () => {
        const out = await pressTab('<html>\n<body>\nul>li*3\n</body>\n</html>\n', 2);
        assert.strictEqual((out.match(/<li>/g) ?? []).length, 3, `expected three <li>; got:\n${out}`);
    });

    test('an abbreviation inside a <% %> block is still left alone', async () => {
        const out = await pressTab('<%\nul>li*3\n%>\n', 1);
        assert.ok(out.includes('ul>li*3'), `VBScript must not be expanded; got:\n${out}`);
    });
});
