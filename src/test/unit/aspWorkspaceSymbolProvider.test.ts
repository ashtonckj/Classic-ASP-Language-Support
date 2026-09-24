import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as stub from './_vscodeStub';
import {
    globToRegExp, isAspFile, findAspFilesInFolder, AssociationRule,
    AspWorkspaceSymbolProvider, disposeWorkspaceIndex,
} from '../../providers/aspWorkspaceSymbolProvider';

// Workspace symbol search (Ctrl+T) used to find files by a hardcoded
// /\.(asp|inc)$/i extension check, so a codebase that keeps its Classic ASP
// code in .html files (via files.associations: {"*.html": "asp"}) was
// invisible to it even though every other feature already honoured that
// association. isAspFile/globToRegExp are the pure logic behind the fix —
// no vscode API involved, so they're covered directly here rather than only
// through the (harder to set up) real workspace scan.

function rule(pattern: string): AssociationRule {
    return { matcher: globToRegExp(pattern), matchesFullPath: pattern.includes('/') };
}

describe('globToRegExp', () => {
    it('matches a bare wildcard extension pattern', () => {
        assert.ok(globToRegExp('*.html').test('_lib.standAlone.html'));
        assert.ok(!globToRegExp('*.html').test('_lib.standAlone.htm'));
    });

    it('treats ? as exactly one character', () => {
        assert.ok(globToRegExp('a?c.asp').test('abc.asp'));
        assert.ok(!globToRegExp('a?c.asp').test('abcc.asp'));
    });

    it('escapes regex-special characters in the literal parts of the glob', () => {
        assert.ok(globToRegExp('lib.name+ext.html').test('lib.name+ext.html'));
        assert.ok(!globToRegExp('lib.name+ext.html').test('libXnameXext.html'));
    });

    it('a double-star crosses directory separators, a single star does not', () => {
        assert.ok(globToRegExp('lib/**/*.html').test('lib/a/b/c.html'));
        assert.ok(!globToRegExp('lib/*.html').test('lib/a/c.html'));
        assert.ok(globToRegExp('lib/*.html').test('lib/c.html'));
    });
});

describe('isAspFile', () => {
    const extensions = ['.asp', '.inc'];

    it('matches the built-in extensions regardless of any association rules', () => {
        assert.ok(isAspFile('C:/site/module.asp', 'module.asp', extensions, []));
        assert.ok(isAspFile('C:/site/common.inc', 'common.inc', extensions, []));
    });

    it('does not match an unrelated extension when there are no rules', () => {
        assert.ok(!isAspFile('C:/site/readme.html', 'readme.html', extensions, []));
    });

    it('matches a .html file via a bare files.associations pattern', () => {
        const rules = [rule('*.html')];
        assert.ok(isAspFile('C:/site/_library/_lib.DateTime.html', '_library/_lib.DateTime.html', extensions, rules));
    });

    it('does not let a bare pattern match a file in a different folder incorrectly', () => {
        // A bare (no-slash) pattern matches on file NAME only, same as VS Code's
        // own files.associations — it should match regardless of which folder
        // the file sits in.
        const rules = [rule('*.html')];
        assert.ok(isAspFile('C:/site/deep/nested/page.html', 'deep/nested/page.html', extensions, rules));
    });

    it('a path-qualified pattern only matches within that path', () => {
        const rules = [rule('legacy/*.html')];
        assert.ok(isAspFile('C:/site/legacy/old.html', 'legacy/old.html', extensions, rules));
        assert.ok(!isAspFile('C:/site/modern/new.html', 'modern/new.html', extensions, rules));
    });

    it('ignores an association rule that does not map to the asp language', () => {
        // getAspAssociationRules() only ever builds rules for entries whose
        // value is "asp" — simulate an unrelated file.associations entry by
        // simply not creating a rule for it at all.
        assert.ok(!isAspFile('C:/site/notes.txt', 'notes.txt', extensions, []));
    });
});

// findAspFilesInFolder does the actual recursive disk walk. It only needs
// plain fs, not vscode, so it's exercised here against a REAL temp directory
// rather than through the (much harder to set up reliably) real workspace
// symbol search command.
describe('findAspFilesInFolder', () => {
    const extensions = ['.asp', '.inc'];
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-find-files-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds files by extension at every depth', () => {
        fs.writeFileSync(path.join(dir, 'top.asp'), '');
        fs.mkdirSync(path.join(dir, 'nested'));
        fs.writeFileSync(path.join(dir, 'nested', 'deep.inc'), '');
        fs.writeFileSync(path.join(dir, 'ignored.txt'), '');

        const found = findAspFilesInFolder(dir, dir, extensions, []);
        assert.strictEqual(found.length, 2);
        assert.ok(found.some(f => f.endsWith('top.asp')));
        assert.ok(found.some(f => f.endsWith('deep.inc')));
    });

    it('finds a .html file only once an association rule maps it to asp', () => {
        fs.writeFileSync(path.join(dir, 'lib.html'), '');

        assert.strictEqual(findAspFilesInFolder(dir, dir, extensions, []).length, 0);

        const rules = [{ matcher: globToRegExp('*.html'), matchesFullPath: false }];
        const found = findAspFilesInFolder(dir, dir, extensions, rules);
        assert.strictEqual(found.length, 1);
        assert.ok(found[0].endsWith('lib.html'));
    });

    it('skips node_modules and dotfolders', () => {
        fs.mkdirSync(path.join(dir, 'node_modules'));
        fs.writeFileSync(path.join(dir, 'node_modules', 'pkg.asp'), '');
        fs.mkdirSync(path.join(dir, '.git'));
        fs.writeFileSync(path.join(dir, '.git', 'hooks.asp'), '');
        fs.writeFileSync(path.join(dir, 'real.asp'), '');

        const found = findAspFilesInFolder(dir, dir, extensions, []);
        assert.deepStrictEqual(found.map(f => path.basename(f)), ['real.asp']);
    });
});

// Ctrl+T asks on every keystroke typed into it. Each ask used to walk every
// folder and stat every file: 90 ms a keystroke on a 2,000-file site. The folders
// are walked once and a file watcher keeps the list current after that.
describe('AspWorkspaceSymbolProvider — the workspace file index', () => {
    const provider = new AspWorkspaceSymbolProvider();
    const token    = { isCancellationRequested: false } as vscode.CancellationToken;
    let dir: string;

    const lib = (fn: string) => `<%\nFunction ${fn}(a)\n  ${fn} = a\nEnd Function\n%>\n`;
    const names = async (query = '') =>
        ((await provider.provideWorkspaceSymbols(query, token)) ?? []).map(s => s.name).sort();

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-ws-index-'));
        fs.writeFileSync(path.join(dir, 'one.asp'), lib('RenderOne'));
        fs.mkdirSync(path.join(dir, 'lib'));
        fs.writeFileSync(path.join(dir, 'lib', 'two.inc'), lib('RenderTwo'));
        stub.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
        disposeWorkspaceIndex();
    });

    afterEach(() => {
        disposeWorkspaceIndex();
        stub.workspace.workspaceFolders = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds the symbols of every ASP file in the workspace', async () => {
        assert.deepStrictEqual(await names(), ['RenderOne', 'RenderTwo']);
    });

    it('answers the next keystroke from the index, without going back to the disk', async () => {
        await names();
        // Written with no watcher event, so only a fresh walk or read would see them.
        fs.writeFileSync(path.join(dir, 'three.asp'), lib('RenderThree'));
        fs.writeFileSync(path.join(dir, 'one.asp'), lib('RenamedOne'));

        assert.deepStrictEqual(await names('render'), ['RenderOne', 'RenderTwo']);
    });

    it('adds a file the watcher reports as created', async () => {
        await names();
        const created = path.join(dir, 'lib', 'three.asp');
        fs.writeFileSync(created, lib('RenderThree'));
        stub.fireFileEvent('create', created);

        assert.deepStrictEqual(await names(), ['RenderOne', 'RenderThree', 'RenderTwo']);
    });

    it('reads a file again once the watcher reports it changed', async () => {
        await names();
        const changed = path.join(dir, 'one.asp');
        fs.writeFileSync(changed, lib('RenamedOne'));
        stub.fireFileEvent('change', changed);

        assert.deepStrictEqual(await names(), ['RenamedOne', 'RenderTwo']);
    });

    it('drops a deleted file, and the files of a deleted folder', async () => {
        await names();
        fs.rmSync(path.join(dir, 'one.asp'));
        stub.fireFileEvent('delete', path.join(dir, 'one.asp'));
        assert.deepStrictEqual(await names(), ['RenderTwo']);

        fs.rmSync(path.join(dir, 'lib'), { recursive: true });
        stub.fireFileEvent('delete', path.join(dir, 'lib'));
        assert.deepStrictEqual(await names(), []);
    });

    it('picks up the files of a folder that arrives whole', async () => {
        await names();
        const folder = path.join(dir, 'copied');
        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, 'four.asp'), lib('RenderFour'));
        stub.fireFileEvent('create', folder);

        assert.deepStrictEqual(await names(), ['RenderFour', 'RenderOne', 'RenderTwo']);
    });

    it('ignores a file created inside node_modules', async () => {
        await names();
        fs.mkdirSync(path.join(dir, 'node_modules'));
        const ignored = path.join(dir, 'node_modules', 'pkg.asp');
        fs.writeFileSync(ignored, lib('FromPackage'));
        stub.fireFileEvent('create', ignored);

        assert.deepStrictEqual(await names(), ['RenderOne', 'RenderTwo']);
    });
});
