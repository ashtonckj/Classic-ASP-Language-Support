import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Include files are parsed by a worker thread, which has no vscode API and so
// can only read what is on disk. Left at that, an unsaved edit to an include was
// invisible to the page including it — you had to press Ctrl+S before the new
// function appeared. Every mainstream language server resolves an open
// dependency from the editor buffer instead, and the worker can too: the
// extension host reads the dirty buffers and sends the text with the request.
//
// This drives the real completion provider, so it covers the whole path —
// buffer collection, worker round trip, cache staleness on the next keystroke.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const dir     = vscode.Uri.file(os.tmpdir());
const LIB_NAME = `asp-live-lib-${process.pid}.asp`;
const libUri  = vscode.Uri.joinPath(dir, LIB_NAME);
const pageUri = vscode.Uri.joinPath(dir, `asp-live-page-${process.pid}.asp`);

const LIB_ON_DISK = [
    '<%',
    'Function SavedOnlyFunction(a)',
    '  SavedOnlyFunction = a',
    'End Function',
    '%>',
    '',
].join('\n');

function page(libName = LIB_NAME): string {
    return [
        '<%@ LANGUAGE="VBSCRIPT" %>',
        `<!--#include file="${libName}"-->`,
        '<%',
        '  Dim result',
        '  result = 1',
        '%>',
        '',
    ].join('\n');
}

/** Completion labels offered inside the page's <% %> block. */
async function labelsInPage(doc: vscode.TextDocument): Promise<string[]> {
    const pos  = doc.lineAt(3).range.end; // end of "  Dim result"
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', doc.uri, pos,
    );
    return (list?.items ?? []).map(i => (typeof i.label === 'string' ? i.label : i.label.label));
}

/** Polls until `name` is offered, or gives up — the worker is asynchronous. */
async function waitForLabel(doc: vscode.TextDocument, name: string, timeoutMs = 6000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if ((await labelsInPage(doc)).includes(name)) { return true; }
        await sleep(150);
    }
    return false;
}

suite('Include symbols follow the editor buffer (integration)', () => {

    suiteSetup(async () => {
        await vscode.workspace.fs.writeFile(libUri, Buffer.from(LIB_ON_DISK, 'utf8'));
        await vscode.workspace.fs.writeFile(pageUri, Buffer.from(page(), 'utf8'));
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        for (const uri of [libUri, pageUri]) {
            try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ }
        }
    });

    test('a function added to an include WITHOUT saving is offered in the including page', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        const pageDoc = await vscode.workspace.openTextDocument(pageUri);
        await vscode.window.showTextDocument(pageDoc);

        // The saved copy's function should arrive once the worker has run.
        assert.ok(
            await waitForLabel(pageDoc, 'SavedOnlyFunction'),
            'the include\'s saved function should be offered',
        );

        // Now edit the include and leave it dirty — no save.
        const libDoc    = await vscode.workspace.openTextDocument(libUri);
        const libEditor = await vscode.window.showTextDocument(libDoc);
        await libEditor.edit(b => b.insert(
            new vscode.Position(4, 0),
            'Function UnsavedFunction(b)\n  UnsavedFunction = b\nEnd Function\n',
        ));
        assert.strictEqual(libDoc.isDirty, true, 'the include must be dirty for this test to mean anything');

        // Back to the page: the unsaved function should now be offered too.
        await vscode.window.showTextDocument(pageDoc);
        assert.ok(
            await waitForLabel(pageDoc, 'UnsavedFunction'),
            'a function added to the include but not saved should still be offered',
        );

        // …and the saved one must not have been lost along the way.
        assert.ok(
            (await labelsInPage(pageDoc)).includes('SavedOnlyFunction'),
            'the previously saved function should still be offered',
        );
    });
});

// A change made outside the editor — a git pull, another editor — fires no
// save, so the include kept its old symbols until the window was reloaded.
suite('Include symbols follow changes made on disk (integration)', () => {

    const EXT_LIB_NAME = `asp-disk-lib-${process.pid}.asp`;
    const extLibPath   = path.join(os.tmpdir(), EXT_LIB_NAME);
    const extPagePath  = path.join(os.tmpdir(), `asp-disk-page-${process.pid}.asp`);
    const lib = (fn: string) => `<%\nFunction ${fn}(a)\n  ${fn} = a\nEnd Function\n%>\n`;

    suiteSetup(() => {
        fs.writeFileSync(extLibPath, lib('BeforeGitPull'));
        fs.writeFileSync(extPagePath, page(EXT_LIB_NAME));
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        for (const file of [extLibPath, extPagePath]) {
            try { fs.unlinkSync(file); } catch { /* already gone */ }
        }
    });

    test('a function written to an include on disk is offered without any save', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        const pageDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(extPagePath));
        await vscode.window.showTextDocument(pageDoc);
        assert.ok(await waitForLabel(pageDoc, 'BeforeGitPull'), 'the include\'s function should be offered');

        // Straight to disk, as a git pull would: the include is never opened.
        fs.writeFileSync(extLibPath, lib('AfterGitPull'));

        assert.ok(
            await waitForLabel(pageDoc, 'AfterGitPull', 10000),
            'the function now on disk should be offered',
        );
        assert.ok(
            !(await labelsInPage(pageDoc)).includes('BeforeGitPull'),
            'the function that is gone from the file should no longer be offered',
        );
    });
});

// Symbols are memoised per document version. Keyed by URI, a page opened after
// another was closed could reuse its entry: a new Untitled-1 takes the closed
// one's name, and both start at version 1.
suite("A new page does not inherit a closed page's symbols (integration)", () => {

    async function labelsInNewPage(content: string, line: number): Promise<string[]> {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument({ language: 'asp', content });
        const editor = await vscode.window.showTextDocument(doc);
        await sleep(300);
        const position = new vscode.Position(line, editor.document.lineAt(line).text.length);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', doc.uri, position,
        );
        return (list?.items ?? []).map(item => typeof item.label === 'string' ? item.label : item.label.label);
    }

    test('completion in the new page offers only its own functions', async () => {
        const before = await labelsInNewPage('<%\nFunction ClosedPageOnly(a)\nEnd Function\nx = Clo\n%>\n', 3);
        assert.ok(before.includes('ClosedPageOnly'), 'the first page should see its own function');

        const after = await labelsInNewPage('<%\nFunction OpenPageOnly(a)\nEnd Function\nx = Op\n%>\n', 3);
        assert.ok(after.includes('OpenPageOnly'), `the new page should see its own function; got ${JSON.stringify(after.slice(0, 25))}`);
        assert.ok(!after.includes('ClosedPageOnly'), "the closed page's function must not be offered");
    });
});

// IIS will not run a page whose #include names a missing file (ASP 0126), and
// nothing said so until the page was tried on the server.
suite('A missing include is flagged where it is written (integration)', () => {

    const MISSING_NAME = `asp-missing-lib-${process.pid}.asp`;
    const missingUri   = vscode.Uri.joinPath(dir, MISSING_NAME);
    const brokenUri    = vscode.Uri.joinPath(dir, `asp-missing-page-${process.pid}.asp`);

    function includeWarnings(uri: vscode.Uri): vscode.Diagnostic[] {
        return vscode.languages.getDiagnostics(uri).filter(d => d.source === 'Classic ASP (includes)');
    }

    async function waitFor(check: () => boolean, timeoutMs = 6000): Promise<boolean> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (check()) { return true; }
            await sleep(100);
        }
        return false;
    }

    suiteSetup(async () => {
        await vscode.workspace.fs.writeFile(brokenUri, Buffer.from(
            `<!--#include file="${MISSING_NAME}"-->\n<%\nIf x Then\ny = 1\nEnd If\n%>\n`, 'utf8',
        ));
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        for (const uri of [missingUri, brokenUri]) {
            try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ }
        }
    });

    test('the path is flagged, formatting still runs, and creating the file clears it', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument(brokenUri);
        await vscode.window.showTextDocument(doc);

        assert.ok(await waitFor(() => includeWarnings(brokenUri).length === 1), 'the missing include should be flagged');
        const [warning] = includeWarnings(brokenUri);
        assert.strictEqual(doc.getText(warning.range), MISSING_NAME);
        assert.strictEqual(warning.severity, vscode.DiagnosticSeverity.Warning);

        // Not a structure problem: Format Document must not refuse because of it.
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatDocumentProvider', brokenUri, { tabSize: 4, insertSpaces: true },
        );
        assert.ok(edits && edits.length > 0, 'the page should still be formatted');

        // Created from inside VS Code, as the Explorer's New File does.
        const create = new vscode.WorkspaceEdit();
        create.createFile(missingUri, { contents: Buffer.from('<% %>\n', 'utf8') });
        assert.ok(await vscode.workspace.applyEdit(create));
        assert.ok(await waitFor(() => includeWarnings(brokenUri).length === 0), 'the warning should clear once the file exists');
    });
});
