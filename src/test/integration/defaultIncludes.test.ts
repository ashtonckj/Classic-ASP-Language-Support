import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';

// aspLanguageSupport.defaultIncludes: files that many real Classic ASP apps only
// pull in through a shared bootstrap/layout page — never through the module
// being edited itself — so IntelliSense/hover/Go to Definition previously had
// no way to see them from that module's own #include chain (which is empty).
//
// The library file and the module both live in the SAME temp directory and
// carry no #include of each other, so any resolution here can only be coming
// from the defaultIncludes setting, not from the ordinary #include chain.

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const LIBRARY = [
    '<%',
    'Function FormatDate(d)',
    '  FormatDate = Year(d)',
    'End Function',
    '%>',
    '',
].join('\n');

const MODULE = [
    '<%',                          // 0
    '  Dim orderDate',             // 1
    '  orderDate = FormatDate(Now())', // 2
    '%>',                          // 3
    '',
].join('\n');

const dir = vscode.Uri.file(os.tmpdir());
const libUri = vscode.Uri.joinPath(dir, `asp-default-include-lib-${process.pid}.asp`);
const moduleUri = vscode.Uri.joinPath(dir, `asp-default-include-module-${process.pid}.asp`);

const config = () => vscode.workspace.getConfiguration('aspLanguageSupport');
let previousDefaultIncludes: string[] | undefined;

async function setDefaultIncludes(value: string[] | undefined): Promise<void> {
    await config().update('defaultIncludes', value, vscode.ConfigurationTarget.Global);
    await sleep(200);
}

suite('aspLanguageSupport.defaultIncludes (integration)', () => {

    suiteSetup(async () => {
        await vscode.workspace.fs.writeFile(libUri, Buffer.from(LIBRARY, 'utf8'));
        await vscode.workspace.fs.writeFile(moduleUri, Buffer.from(MODULE, 'utf8'));
        previousDefaultIncludes = config().get<string[]>('defaultIncludes');
    });

    suiteTeardown(async () => {
        await setDefaultIncludes(previousDefaultIncludes);
        try { await vscode.workspace.fs.delete(libUri); } catch { /* already gone */ }
        try { await vscode.workspace.fs.delete(moduleUri); } catch { /* already gone */ }
    });

    async function openModule(): Promise<vscode.TextDocument> {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const doc = await vscode.workspace.openTextDocument(moduleUri);
        await vscode.window.showTextDocument(doc);
        await sleep(300);
        return doc;
    }

    function posOfFormatDateCall(doc: vscode.TextDocument): vscode.Position {
        const idx = MODULE.indexOf('FormatDate(Now())');
        assert.ok(idx >= 0);
        return doc.positionAt(idx + 1);
    }

    test('Go to Definition fails without defaultIncludes configured', async () => {
        await setDefaultIncludes([]);
        const doc = await openModule();

        const out = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider', doc.uri, posOfFormatDateCall(doc),
        );
        assert.ok(!out?.length, `expected no definition without defaultIncludes; got ${JSON.stringify(out)}`);
    });

    test('Go to Definition resolves a function only reachable via defaultIncludes', async () => {
        await setDefaultIncludes([libUri.fsPath]);
        const doc = await openModule();

        const out = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider', doc.uri, posOfFormatDateCall(doc),
        );
        assert.strictEqual(out?.length, 1, `expected one definition; got ${JSON.stringify(out)}`);
        assert.strictEqual(out![0].uri.fsPath.toLowerCase(), libUri.fsPath.toLowerCase());
    });

    test('Hover shows the signature of a function only reachable via defaultIncludes', async () => {
        await setDefaultIncludes([libUri.fsPath]);
        const doc = await openModule();

        const out = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider', doc.uri, posOfFormatDateCall(doc),
        );
        const text = out?.map(h => h.contents.map(c => (typeof c === 'string' ? c : c.value)).join('\n')).join('\n') ?? '';
        assert.ok(/FormatDate/i.test(text), `expected FormatDate in hover text; got ${JSON.stringify(text)}`);
    });

    test('Completion offers a name only reachable via defaultIncludes', async () => {
        await setDefaultIncludes([libUri.fsPath]);
        const doc = await openModule();

        // AspCompletionProvider returns its full known-symbol list regardless of
        // any prefix already typed (VS Code's own UI does the fuzzy filtering),
        // so any ordinary position inside the <% %> block is enough to ask from.
        const pos = doc.lineAt(1).range.end; // end of "  Dim orderDate"
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', doc.uri, pos,
        );
        const labels = (list?.items ?? []).map(i => (typeof i.label === 'string' ? i.label : i.label.label));
        assert.ok(labels.includes('FormatDate'), `expected FormatDate offered; got ${JSON.stringify(labels)}`);
    });
});
