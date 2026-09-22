import * as assert from 'assert';
import * as vscode from 'vscode';

// Close what the test opened. Each test here opens a document and never closed
// it, so across a full run the editors accumulated -- by the time the later
// suites ran there were dozens open at once, and the active editor is what every
// command in this file acts through. Run on its own the suite passed every time;
// run after the others it failed intermittently, always by the command appearing
// to do nothing at all.
teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

// A Classic ASP page is four languages in one file, and the editor has to pick
// the right rules for wherever the caret is. VS Code does that from the grammar
// contribution's `embeddedLanguages` map, which keys on the SCOPE NAMES the
// grammar actually emits — so a key that names a scope this grammar never
// produces silently leaves that zone using the outer language's rules.
//
// Two keys were wrong that way, which is why Ctrl+/ on a line of HTML inserted a
// VBScript apostrophe. These tests pin the behaviour a Classic ASP author should
// get, per zone, so a future grammar change that renames a scope fails here.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const LINES = [
    '<%@ Language="VBScript" %>',   // 0
    '<html>',                       // 1
    '<body>',                       // 2
    '<div>hello</div>',             // 3  html
    '<%',                           // 4
    '  Dim x : x = 1',              // 5  vbscript
    '%>',                           // 6
    '<style>',                      // 7
    '  .a { color: red; }',         // 8  css
    '</style>',                     // 9
    '<script>',                     // 10
    '  var total = 0;',             // 11 js
    '</script>',                    // 12
    '</body>',                      // 13
    '</html>',                      // 14
];
const DOC = LINES.join('\n');

async function openAsp(content = DOC): Promise<vscode.TextEditor> {
    // Each case needs its own clean editor: the comment commands act on the
    // ACTIVE editor, and editors left open by earlier cases can still hold it.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
    const editor = await vscode.window.showTextDocument(doc);
    // The comment commands read the language of the token under the caret, and a
    // just-opened document has not been tokenized yet — without this the whole
    // file still reports the document's own language and every zone looks the
    // same. A real editing session is always past this point.
    await sleep(500);
    return editor;
}

/**
 * Waits for `line` to stop reading `before`, or gives up and returns it as-is.
 *
 * A fixed sleep is not enough: toggling a line comment in CSS goes through the
 * block-comment fallback (CSS has no line comment at all), which lands later
 * than the other zones. Polling keeps the "nothing was inserted" assertions
 * honest — they still get the unchanged text, just after a real wait.
 */
async function lineSettles(
    document: vscode.TextDocument, line: number, before: string,
): Promise<string> {
    for (let waited = 0; waited < 2000; waited += 50) {
        const now = document.lineAt(line).text;
        if (now !== before) { return now; }
        await sleep(50);
    }
    return document.lineAt(line).text;
}

/** Runs `command` with the caret on `line` and returns that line afterwards. */
async function afterCommand(line: number, command: string): Promise<string> {
    const editor = await openAsp();
    const before = editor.document.lineAt(line).text;
    editor.selection = new vscode.Selection(line, 2, line, 2);
    await vscode.commands.executeCommand(command);
    return lineSettles(editor.document, line, before);
}

/**
 * Same, but with the line's content selected first.
 *
 * Toggle Block Comment wraps a selection; with a bare caret it just drops an
 * empty pair in at the cursor, which says nothing about the syntax in use.
 */
async function afterBlockComment(line: number): Promise<string> {
    const editor = await openAsp();
    const text = editor.document.lineAt(line).text;
    const from = text.length - text.trimStart().length;
    editor.selection = new vscode.Selection(line, from, line, text.length);
    await vscode.commands.executeCommand('editor.action.blockComment');
    return lineSettles(editor.document, line, text);
}

suite('Comment toggling follows the zone under the caret (integration)', () => {

    // A zone's rules come from the embedded language's own configuration, and a
    // language that nothing has opened yet has none loaded — in this harness
    // (which launches with --disable-extensions) a cold CSS registry makes
    // Toggle Comment a no-op in <style>, for reasons that have nothing to do
    // with this grammar. Opening one document per embedded language puts the
    // registry in the state any real editing session is already in.
    suiteSetup(async () => {
        for (const language of ['html', 'css', 'javascript']) {
            const doc = await vscode.workspace.openTextDocument({ language, content: '' });
            await vscode.window.showTextDocument(doc);
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    // ── Ctrl+/ ───────────────────────────────────────────────────────────────
    const LINE_COMMENT: Array<[string, number, string]> = [
        ['HTML uses an HTML comment',       3,  '<!-- <div>hello</div> -->'],
        ['VBScript uses an apostrophe',     5,  "  ' Dim x : x = 1"],
        ['CSS uses a block comment',        8,  '  /* .a { color: red; } */'],
        ['JavaScript uses a line comment',  11, '  // var total = 0;'],
    ];

    for (const [label, line, expected] of LINE_COMMENT) {
        test(`line comment — ${label}`, async () => {
            assert.strictEqual(await afterCommand(line, 'editor.action.commentLine'), expected);
        });
    }

    // ── Shift+Alt+A ──────────────────────────────────────────────────────────
    // VBScript has NO block comment. `<%-- --%>` is ASP.NET Web Forms syntax; in
    // Classic ASP it is `<%` followed by `--`, which does not parse and takes the
    // page down. So the correct outcome inside <% %> is that nothing is inserted.
    test('block comment — HTML uses an HTML comment', async () => {
        assert.strictEqual(
            await afterBlockComment(3),
            '<!-- <div>hello</div> -->',
        );
    });

    test('block comment — VBScript is left alone rather than given ASP.NET syntax', async () => {
        const after = await afterBlockComment(5);
        assert.ok(
            !after.includes('<%--') && !after.includes('--%>'),
            `Classic ASP has no block comment, so none should be inserted; got ${JSON.stringify(after)}`,
        );
    });

    test('block comment — CSS uses a block comment', async () => {
        assert.strictEqual(
            await afterBlockComment(8),
            '  /* .a { color: red; } */',
        );
    });

    test('block comment — JavaScript uses a block comment', async () => {
        assert.strictEqual(
            await afterBlockComment(11),
            '  /* var total = 0; */',
        );
    });
});

suite('Zone-aware editing survives the embedded-language mapping (integration)', () => {

    /** Types `text` at the end of `line`, as a person would. */
    async function typeAtEndOf(content: string, line: number, text: string): Promise<string> {
        const editor = await openAsp(content);
        const col = editor.document.lineAt(line).text.length;
        editor.selection = new vscode.Selection(line, col, line, col);
        for (const ch of text) {
            await vscode.commands.executeCommand('type', { text: ch });
            await sleep(20);
        }
        await sleep(120);
        return editor.document.lineAt(line).text;
    }

    // Mapping the HTML zone to the `html` language means the HTML zone no longer
    // uses this extension's own language configuration, so the <% %> pair it
    // declares has to keep working some other way.
    test('typing <% in the HTML body still closes with %>', async () => {
        const after = await typeAtEndOf('<html>\n<body>\n\n</body>\n</html>\n', 2, '<%');
        assert.ok(
            after.includes('%>'),
            `<% should auto-close to <%%>; got ${JSON.stringify(after)}`,
        );
    });

    test("typing a quote in a <script> block auto-closes as JavaScript", async () => {
        const after = await typeAtEndOf(
            '<script>\nvar s = \n</script>\n', 1, "'",
        );
        assert.ok(
            after.endsWith("''"),
            `a single quote should pair inside JS; got ${JSON.stringify(after)}`,
        );
    });

    test('an apostrophe in a <% %> block does NOT auto-close', async () => {
        // It starts a VBScript comment, so pairing it would be wrong.
        const after = await typeAtEndOf('<%\nDim x\n%>\n', 1, " '");
        assert.ok(
            !after.endsWith("''"),
            `an apostrophe is a VBScript comment, not a pair; got ${JSON.stringify(after)}`,
        );
    });
});
