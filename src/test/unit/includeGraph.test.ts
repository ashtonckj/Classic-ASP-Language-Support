import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as stub from './_vscodeStub';
import { fakeDocument } from './_helpers';
import { includedByMap, registerIncludeGraph } from '../../asp/includeGraph';
import { aspIndexSettled, disposeWorkspaceIndex, getWorkspaceAspFiles } from '../../platform/workspaceIndex';
import { pathKey } from '../../core/paths';

// Which pages include which, for F12, hover and rename. Read once and kept
// current from the workspace watcher, rather than read again on every ask.
describe('includeGraph — which pages include which', () => {
    let dir: string;
    let context: { subscriptions: vscode.Disposable[] };
    const file = (name: string) => path.join(dir, name);
    const includers = (document: vscode.TextDocument, name: string, fresh = false) =>
        (includedByMap(document, fresh).get(pathKey(file(name))) ?? []).map(p => path.basename(p)).sort();

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-graph-'));
        fs.writeFileSync(file('page.asp'), '<!--#include file="lib.inc"-->\n<% Call Helper() %>');
        fs.writeFileSync(file('other.asp'), '<!--#include virtual="/lib.inc"-->');
        fs.writeFileSync(file('lib.inc'), '<% Sub Helper : End Sub %>');
        stub.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
        disposeWorkspaceIndex();
        context = { subscriptions: [] };
        registerIncludeGraph(context as unknown as vscode.ExtensionContext);
        getWorkspaceAspFiles();
    });

    afterEach(() => {
        for (const disposable of context.subscriptions) { disposable.dispose(); }
        disposeWorkspaceIndex();
        stub.workspace.workspaceFolders = undefined;
        stub.workspace.textDocuments = [];
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds the pages that include a file, by file= and by virtual=', () => {
        const lib = fakeDocument('', { fsPath: file('lib.inc') }) as unknown as vscode.TextDocument;
        assert.deepStrictEqual(includers(lib, 'lib.inc'), ['other.asp', 'page.asp']);
    });

    it('answers again from what it read, not from the disk', () => {
        const lib = fakeDocument('', { fsPath: file('lib.inc') }) as unknown as vscode.TextDocument;
        includers(lib, 'lib.inc');
        // Written with no watcher event: only a fresh read would see it.
        fs.writeFileSync(file('page.asp'), '<% x = 1 %>');
        assert.deepStrictEqual(includers(lib, 'lib.inc'), ['other.asp', 'page.asp']);
        assert.deepStrictEqual(includers(lib, 'lib.inc', true), ['other.asp'], 'rename reads every page again');
    });

    it('reads a page again once the watcher reports it changed', async () => {
        const lib = fakeDocument('', { fsPath: file('lib.inc') }) as unknown as vscode.TextDocument;
        includers(lib, 'lib.inc');
        fs.writeFileSync(file('page.asp'), '<% x = 1 %>');
        stub.fireFileEvent('change', file('page.asp'));
        await aspIndexSettled();
        assert.deepStrictEqual(includers(lib, 'lib.inc'), ['other.asp']);

        fs.writeFileSync(file('third.asp'), '<!--#include file="lib.inc"-->');
        stub.fireFileEvent('create', file('third.asp'));
        fs.rmSync(file('other.asp'));
        stub.fireFileEvent('delete', file('other.asp'));
        await aspIndexSettled();
        assert.deepStrictEqual(includers(lib, 'lib.inc'), ['third.asp']);
    });

    it('counts an unsaved include the way the buffer has it', () => {
        const page = fakeDocument('<!--#include file="lib.inc"-->', { fsPath: file('page.asp') });
        page.setText('<% x = 1 %>');
        Object.assign(page, { isDirty: true });
        stub.workspace.textDocuments = [page];
        const lib = fakeDocument('', { fsPath: file('lib.inc') }) as unknown as vscode.TextDocument;
        assert.deepStrictEqual(includers(lib, 'lib.inc'), ['other.asp']);
    });
});
