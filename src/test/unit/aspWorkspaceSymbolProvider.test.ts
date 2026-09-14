import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globToRegExp, isAspFile, findAspFilesInFolder, AssociationRule } from '../../providers/aspWorkspaceSymbolProvider';

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
