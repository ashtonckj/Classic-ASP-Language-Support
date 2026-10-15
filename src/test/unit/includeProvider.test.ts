import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as stub from './_vscodeStub';
import { fakeDocument } from './_helpers';
import {
    areIncludeSymbolsReady, collectIncludeSymbols, disposeIncludeWatchers, getVirtualRoot, includeNamedElements, preloadIncludeSymbols, readIncludeText, watchIncludeChanges,
} from '../../asp/includeProvider';
import { aspIndexSettled, disposeWorkspaceIndex } from '../../platform/workspaceIndex';
import { editorWorkspace } from '../../asp/vbscriptWorkspace';
import { buildScriptScope } from '../../vbscript/scriptScope';
import { symbolsOfPage } from '../../vbscript/symbols';

describe('readIncludeText', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-text-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    // VS Code strips the mark, so keeping it would put every position on the
    // first line one column to the right, and rename would edit the wrong text.
    it('drops a UTF-8 byte order mark, as the editor does', () => {
        const file = path.join(dir, 'lib.inc');
        fs.writeFileSync(file, '﻿<% Sub Bump() : End Sub %>');
        assert.strictEqual(readIncludeText(file), '<% Sub Bump() : End Sub %>');
    });
});

// An include open with unsaved edits is read from its buffer. Once that buffer
// is gone without a save, nothing on disk changes, so the cache has to notice
// by itself or the page keeps offering names that no longer exist.
describe('include symbols read from an unsaved buffer', function () {
    this.timeout(20000);
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-buffer-')); });
    afterEach(() => {
        stub.workspace.textDocuments = [];
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const functionNames = (page: ReturnType<typeof fakeDocument>) =>
        collectIncludeSymbols(page as never).functions.map(f => f.name).sort();

    for (const [what, after] of [
        ['undone back to the saved text', (lib: { version: number }) => ({ ...lib, isDirty: false, version: lib.version + 1 })],
        ['closed without saving', undefined],
    ] as const) {
        it(`are read again once the edits are ${what}`, async () => {
            const libPath = path.join(dir, 'lib.inc');
            fs.writeFileSync(libPath, '<% Sub Saved : End Sub %>');
            const page = fakeDocument('<!--#include file="lib.inc"-->', { fsPath: path.join(dir, 'page.asp') });
            const lib = { ...fakeDocument('<% Sub Saved : End Sub : Sub Unsaved : End Sub %>', { fsPath: libPath }), isDirty: true };
            stub.workspace.textDocuments = [lib];

            await preloadIncludeSymbols(page as never);
            assert.deepStrictEqual(functionNames(page), ['Saved', 'Unsaved']);

            stub.workspace.textDocuments = after ? [after(lib)] : [];
            assert.strictEqual(areIncludeSymbolsReady(page as never), false);
            await preloadIncludeSymbols(page as never);
            assert.deepStrictEqual(functionNames(page), ['Saved']);
        });
    }
});

// Completion's include symbols and the binder behind F12, rename and the checks
// must agree on which files a page includes.
describe('the files a page includes', function () {
    this.timeout(20000);
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-parity-')); });
    afterEach(() => {
        stub.testSettings.delete('classicAsp.defaultIncludes');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('are the same for completion as for the script scope', async () => {
        const write = (name: string, text: string) => {
            fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            fs.writeFileSync(path.join(dir, name), text);
        };
        // No folder is open and no virtualRoot is set, so virtual= starts at each file's own folder.
        write('lib/a.inc', '<!--#include file="b.inc"--><!--#include virtual="/nested/n.inc"--><% Sub A : End Sub %>');
        write('lib/b.inc', '<!--#include file="a.inc"--><!--#include file="shared.inc"--><% Sub B : End Sub %>');
        write('lib/nested/n.inc', '<% Sub N : End Sub %>');
        write('lib/shared.inc', '<% Sub Common : End Sub %>');
        write('defaults/d.inc', '<% Sub D : End Sub %>');
        stub.testSettings.set('classicAsp.defaultIncludes', ['defaults/d.inc']);
        const pagePath = path.join(dir, 'page.asp');
        const page = fakeDocument('<!--#include virtual="/lib/a.inc"--><!--#include file="lib/shared.inc"--><% Sub Page : End Sub %>', { fsPath: pagePath });

        await preloadIncludeSymbols(page as never);
        const completion = collectIncludeSymbols(page as never).functions.map(f => f.name).sort();

        const scope = buildScriptScope(pagePath, page.getText(), editorWorkspace(page as never));
        const bound = scope.files.filter(file => file !== scope.root).flatMap(file => symbolsOfPage(file.page, file.path).functions.map(f => f.name)).sort();

        assert.deepStrictEqual(completion, ['A', 'B', 'Common', 'D', 'N']);
        assert.deepStrictEqual(completion, bound);
    });
});

// A change made outside the editor reaches the include symbols: through the
// workspace watcher for an include in the workspace, through a watcher on its
// folder for one outside it.
describe('include symbols after the include changes on disk', function () {
    this.timeout(20000);
    let site: string;
    let outside: string;
    let watching: { dispose(): void }[];
    beforeEach(() => {
        site = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-site-'));
        outside = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-outside-'));
        stub.workspace.workspaceFolders = [{ uri: { fsPath: site } }];
        disposeWorkspaceIndex();
        watching = watchIncludeChanges();
    });
    afterEach(() => {
        for (const disposable of watching) { disposable.dispose(); }
        disposeIncludeWatchers();
        disposeWorkspaceIndex();
        stub.workspace.workspaceFolders = undefined;
        fs.rmSync(site, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    for (const [where, folder] of [['in the workspace', () => site], ['outside the workspace', () => outside]] as const) {
        it(`are read again when an include ${where} changes`, async () => {
            const libPath = path.join(folder(), 'lib.inc');
            fs.writeFileSync(libPath, '<% Sub Before : End Sub %>');
            const page = fakeDocument(`<!--#include file="${libPath}"-->`, { fsPath: path.join(site, 'page.asp') });

            await preloadIncludeSymbols(page as never);
            await aspIndexSettled();
            assert.strictEqual(areIncludeSymbolsReady(page as never), true);

            fs.writeFileSync(libPath, '<% Sub After : End Sub %>');
            stub.fireFileEvent('change', libPath);
            assert.strictEqual(areIncludeSymbolsReady(page as never), false);
            await preloadIncludeSymbols(page as never);
            assert.deepStrictEqual(collectIncludeSymbols(page as never).functions.map(f => f.name), ['After']);
        });
    }
});

// virtual="/inc/db.asp" in a page of the second folder of a multi-root
// workspace named a file under the first folder.
describe('getVirtualRoot', () => {
    const a = path.resolve(path.sep, 'sites', 'a');
    const b = path.resolve(path.sep, 'sites', 'b');
    afterEach(() => { stub.workspace.workspaceFolders = undefined; });

    it('is the root of the workspace folder holding the page', () => {
        stub.workspace.workspaceFolders = [{ uri: { fsPath: a } }, { uri: { fsPath: b } }];
        assert.strictEqual(getVirtualRoot(path.join(b, 'admin', 'page.asp')), b);
        assert.strictEqual(getVirtualRoot(path.join(a, 'page.asp')), a);
    });

    it('is the first folder for a page outside every folder', () => {
        stub.workspace.workspaceFolders = [{ uri: { fsPath: a } }, { uri: { fsPath: b } }];
        assert.strictEqual(getVirtualRoot(path.resolve(path.sep, 'elsewhere', 'page.asp')), a);
    });
});

// The page's JavaScript knows document.myForm when the form is in an include.
describe('includeNamedElements', function () {
    this.timeout(20000);
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-named-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('gives the named forms, images and frames of the includes, nested ones too', async () => {
        fs.writeFileSync(path.join(dir, 'header.inc'), '<!--#include file="form.inc"--><img name="logo" src="a.png"><div name="no">');
        fs.writeFileSync(path.join(dir, 'form.inc'), '<form name="webform" method="post"><input name="forder"></form>');
        const page = fakeDocument('<!--#include file="header.inc"-->', { fsPath: path.join(dir, 'page.asp') });
        await preloadIncludeSymbols(page as never);
        assert.deepStrictEqual(includeNamedElements(page as never).split('\n'),
            ['<img name="logo" src="a.png">', '<form name="webform" method="post">']);
    });
});
