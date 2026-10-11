import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as stub from './_vscodeStub';
import { fakeDocument } from './_helpers';
import { areIncludeSymbolsReady, collectIncludeSymbols, getVirtualRoot, preloadIncludeSymbols, readIncludeText } from '../../asp/includeProvider';

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
