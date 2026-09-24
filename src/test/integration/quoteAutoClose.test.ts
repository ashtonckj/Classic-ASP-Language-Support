import * as assert from 'assert';
import * as vscode from 'vscode';

// Typing a single quote has to follow the zone under the caret: in VBScript `'`
// starts a comment and must never be doubled, while in the markup, <style> and
// <script> it should behave exactly as it does in a plain .html file.
//
// VS Code auto-closes from the DOCUMENT's language, so an .asp page follows
// asp's language-configuration in every zone. That file closes `'` with html's
// own pair, and registerVbScriptQuoteGuard takes the closing quote away again
// when the caret is in VBScript. The extension used to override the global
// `type` command instead, which doubled every apostrophe in page text (`don't`
// came out as `don't'`).
//
// So every markup, CSS and JavaScript case below types into an ASP page AND into
// the same text as a plain .html document, and asserts the two agree — including
// typing over the quote, deleting the pair, and leaving it with the caret.
// VBScript has no .html counterpart; there the assertion is that nothing is
// inserted.

teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Where `|` marks the carets in `marked`, and the text without them. */
function parseCarets(marked: string): { text: string; carets: vscode.Position[] } {
    const carets: vscode.Position[] = [];
    const lines = marked.split('\n').map((line, lineNo) => {
        let out = '';
        for (const ch of line) {
            if (ch === '|') { carets.push(new vscode.Position(lineNo, out.length)); }
            else { out += ch; }
        }
        return out;
    });
    return { text: lines.join('\n'), carets };
}

/** The document text with `|` wherever a caret now sits. */
function markCarets(editor: vscode.TextEditor): string {
    const lines = editor.document.getText().split('\n');
    const byLine = new Map<number, number[]>();
    for (const sel of editor.selections) {
        const list = byLine.get(sel.active.line) ?? [];
        list.push(sel.active.character);
        byLine.set(sel.active.line, list);
    }
    return lines.map((line, lineNo) => {
        const cols = (byLine.get(lineNo) ?? []).sort((a, b) => b - a);
        let out = line;
        for (const col of cols) { out = out.slice(0, col) + '|' + out.slice(col); }
        return out;
    }).join('\n');
}

/** Waits until the document has stopped changing — the closing quote lands a moment after the key. */
async function settled(document: vscode.TextDocument, from: number): Promise<void> {
    for (let waited = 0; document.version === from && waited < 1000; waited += 20) { await sleep(20); }
    let last = document.version;
    for (let quiet = 0; quiet < 200; quiet += 20) {
        await sleep(20);
        if (document.version !== last) { last = document.version; quiet = 0; }
    }
}

const KEYS: Record<string, string> = {
    BS: 'deleteLeft', LEFT: 'cursorLeft', RIGHT: 'cursorRight', END: 'cursorEnd', UNDO: 'undo',
};

/**
 * Opens `marked` as `language`, presses `keys` — a character is typed, a name in
 * KEYS runs that command — and returns the text with the carets marked. With
 * `select`, the first two carets become one selection (anchor, active).
 */
async function typeInto(
    language: string, marked: string, keys: string[], select = false,
): Promise<string> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const { text, carets } = parseCarets(marked);
    const doc = await vscode.workspace.openTextDocument({ language, content: text });
    const editor = await vscode.window.showTextDocument(doc);
    // The zone is read from the grammar, and a just-opened document has not
    // been tokenized yet.
    await sleep(500);

    editor.selections = select
        ? [new vscode.Selection(carets[0], carets[1])]
        : carets.map(c => new vscode.Selection(c, c));

    for (const key of keys) {
        const from = doc.version;
        if (KEYS[key]) { await vscode.commands.executeCommand(KEYS[key]); }
        else { await vscode.commands.executeCommand('type', { text: key }); }
        await settled(doc, from);
    }
    return markCarets(editor);
}

/** Types into an ASP page and into the same text as .html; both must agree. */
async function assertMatchesHtml(marked: string, keys: string[] = ["'"], select = false): Promise<string> {
    const asp  = await typeInto('asp',  marked, keys, select);
    const html = await typeInto('html', marked, keys, select);
    assert.strictEqual(asp, html, `an ASP page should behave like .html for ${JSON.stringify(marked)} + ${keys.join(' ')}`);
    return asp;
}

suite('Single-quote auto-closing follows the zone under the caret (integration)', () => {

    // A language nothing has opened yet has no configuration loaded; see
    // embeddedZones.test.ts.
    suiteSetup(async () => {
        for (const language of ['html', 'css', 'javascript']) {
            const doc = await vscode.workspace.openTextDocument({ language, content: '' });
            await vscode.window.showTextDocument(doc);
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    // ── Markup: when a quote is closed ──────────────────────────────────────

    test('an apostrophe in page text is not doubled', async () => {
        assert.strictEqual(await assertMatchesHtml('<p>don|</p>'), "<p>don'|</p>");
    });

    test('an apostrophe after a digit, an underscore or a letter with an accent is not doubled', async () => {
        await assertMatchesHtml('<p>1|');
        await assertMatchesHtml('<p>_|');
        await assertMatchesHtml('<p>é|');
    });

    test('a quote at the end of a line is closed', async () => {
        assert.strictEqual(await assertMatchesHtml('<p>Pick one |'), "<p>Pick one '|'");
    });

    test('a quote before a closing tag is not closed', async () => {
        await assertMatchesHtml('<p>Pick one |</p>');
    });

    test('a quote is closed before ) . and ;, but not before a letter or a quote', async () => {
        await assertMatchesHtml('<p>Hello |)');
        await assertMatchesHtml('<p>Hello |.');
        await assertMatchesHtml('<p>Hello |;');
        await assertMatchesHtml('<p>Hello |x');
        await assertMatchesHtml('<p>Hello |"');
        await assertMatchesHtml("<p>Hello |'");
    });

    // The one place an ASP page parts from .html: in front of `-->`, where html
    // closes the quote because `-->` ends one of its own pairs. asp's pairs have
    // no `<!--`, since the extension closes HTML comments itself.
    test('a quote before --> is not closed', async () => {
        assert.strictEqual(await typeInto('asp', '<p>Hello |-->', ["'"]), "<p>Hello '|-->");
    });

    test('a quote after ( or = is closed', async () => {
        await assertMatchesHtml('<p>(|');
        await assertMatchesHtml('<p>=|');
    });

    test('an attribute value quote is closed', async () => {
        assert.strictEqual(await assertMatchesHtml('<div class=|>'), "<div class='|'>");
    });

    test('a quote inside a double-quoted attribute value is not closed', async () => {
        await assertMatchesHtml('<div title="a |">');
        await assertMatchesHtml("<div title='a |'>");
    });

    test('a quote in an HTML comment is closed like .html', async () => {
        await assertMatchesHtml('<!-- see |');
    });

    // ── Markup: after the quote is closed ───────────────────────────────────

    test('typing the closing quote steps over the inserted one', async () => {
        assert.strictEqual(await assertMatchesHtml('<div class=|>', ["'", 'a', "'"]), "<div class='a'|>");
        await assertMatchesHtml('<div class=|>', ["'", "'"]);
    });

    test('Backspace between an empty pair deletes both quotes', async () => {
        assert.strictEqual(await assertMatchesHtml('<div class=|>', ["'", 'BS']), '<div class=|>');
        await assertMatchesHtml('<div class=|>', ["'", 'a', 'BS', 'BS']);
    });

    test('leaving the pair with the caret stops it being stepped over', async () => {
        await assertMatchesHtml('<div class=|>', ["'", 'a', 'LEFT', 'LEFT', 'RIGHT', 'RIGHT', "'"]);
        await assertMatchesHtml('<p>x |', ["'", 'END', "'"]);
    });

    test('a selection is wrapped in quotes', async () => {
        await assertMatchesHtml('<p>|word|</p>', ["'"], true);
    });

    test('several carets are closed together', async () => {
        assert.strictEqual(
            await assertMatchesHtml('<div class=|></div>\n<div class=|></div>'),
            "<div class='|'></div>\n<div class='|'></div>",
        );
        await assertMatchesHtml('<a id=|><a id=|>', ["'", 'x', "'"]);
    });

    test('one undo removes the quote and its closing quote together', async () => {
        await assertMatchesHtml('<p>Pick one |', ["'", 'UNDO']);
    });

    test('a markup line between ASP blocks behaves like .html', async () => {
        const asp = await typeInto('asp', '<% x = 1 %>\n<p>it|</p>\n<% y = 2 %>', ["'"]);
        assert.strictEqual(asp, "<% x = 1 %>\n<p>it'|</p>\n<% y = 2 %>");
    });

    // ── <script> and <style> ────────────────────────────────────────────────

    test('a JS string quote is closed', async () => {
        assert.strictEqual(await assertMatchesHtml('<script>\n  var s = |;\n</script>'), "<script>\n  var s = '|';\n</script>");
    });

    test('JS strings and comments are treated the way .html treats them', async () => {
        await assertMatchesHtml('<script>\n  var s = "it|";\n</script>');
        await assertMatchesHtml('<script>\n  // don|\n</script>');
        await assertMatchesHtml('<script>\n  // see |\n</script>');
        await assertMatchesHtml('<script>\n  var s = "a |\n</script>');
        await assertMatchesHtml("<script>\n  var s = 'a |\n</script>");
        await assertMatchesHtml('<script>\n  var t = `a |`;\n</script>');
    });

    test('a CSS string quote is closed', async () => {
        await assertMatchesHtml('<style>\n  .a { content: |; }\n</style>');
    });

    test('CSS strings and comments are treated the way .html treats them', async () => {
        await assertMatchesHtml('<style>\n  .a { /* see | */ }\n</style>');
        await assertMatchesHtml('<style>\n  .a { content: "a |" }\n</style>');
    });

    test('a quote in a style attribute behaves like .html', async () => {
        await assertMatchesHtml('<div style="font-family: |">');
    });

    // ── VBScript ────────────────────────────────────────────────────────────

    test('a quote in a one-line <% %> block starts a comment, nothing is added', async () => {
        assert.strictEqual(await typeInto('asp', '<% x = 1 | %>', ["'"]), "<% x = 1 '| %>");
    });

    test('a quote in a multi-line block starts a comment, nothing is added', async () => {
        assert.strictEqual(await typeInto('asp', '<%\n  Dim total |\n%>', ["'"]), "<%\n  Dim total '|\n%>");
    });

    test('a quote at the start of an empty VBScript line is not doubled', async () => {
        assert.strictEqual(await typeInto('asp', '<%\n  |\n%>', ["'"]), "<%\n  '|\n%>");
    });

    test('a quote in a <script language="vbscript"> body is not doubled', async () => {
        assert.strictEqual(
            await typeInto('asp', '<script language="vbscript">\n  x = 1 |\n</script>', ["'"]),
            '<script language="vbscript">\n  x = 1 \'|\n</script>',
        );
    });

    test('carets in markup and in VBScript each follow their own zone', async () => {
        assert.strictEqual(
            await typeInto('asp', '<div class=|>\n<% x = 1 | %>', ["'"]),
            "<div class='|'>\n<% x = 1 '| %>",
        );
    });

    test('pasting two quotes into VBScript keeps both', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: '<% sql = "a = " %>' });
        const editor = await vscode.window.showTextDocument(doc);
        await sleep(500);
        // Inserted at the caret as one edit, the caret ending after it — the way
        // a paste lands.
        editor.selection = new vscode.Selection(0, 14, 0, 14);
        const from = doc.version;
        await editor.edit(eb => eb.insert(new vscode.Position(0, 14), "''"));
        await settled(doc, from);
        assert.strictEqual(doc.getText(), `<% sql = "a = ''" %>`);
    });

    test('a quote in a VBScript comment typed without pausing is still not doubled', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content: '<%\n  x = 1 \n%>' });
        const editor = await vscode.window.showTextDocument(doc);
        await sleep(500);
        editor.selection = new vscode.Selection(1, 8, 1, 8);
        const from = doc.version;
        for (const ch of "' note") {
            await vscode.commands.executeCommand('type', { text: ch });
        }
        await settled(doc, from);
        assert.strictEqual(markCarets(editor), "<%\n  x = 1 ' note|\n%>");
    });

    // ── The user's own settings ─────────────────────────────────────────────

    test('editor.autoClosingQuotes is honoured', async () => {
        const config = vscode.workspace.getConfiguration('editor');
        try {
            await config.update('autoClosingQuotes', 'never', vscode.ConfigurationTarget.Global);
            assert.strictEqual(await typeInto('asp', '<div class=|>', ["'"]), "<div class='|>");
            await config.update('autoClosingQuotes', 'beforeWhitespace', vscode.ConfigurationTarget.Global);
            await assertMatchesHtml('<div class=|>');
            await assertMatchesHtml('<p>x | y');
        } finally {
            await config.update('autoClosingQuotes', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('editor.autoClosingOvertype and autoClosingDelete "never" are honoured', async () => {
        const config = vscode.workspace.getConfiguration('editor');
        try {
            await config.update('autoClosingOvertype', 'never', vscode.ConfigurationTarget.Global);
            await config.update('autoClosingDelete', 'never', vscode.ConfigurationTarget.Global);
            await assertMatchesHtml('<div class=|>', ["'", "'"]);
            await assertMatchesHtml('<div class=|>', ["'", 'BS']);
        } finally {
            await config.update('autoClosingOvertype', undefined, vscode.ConfigurationTarget.Global);
            await config.update('autoClosingDelete', undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
