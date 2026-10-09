import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { pathCompletions } from '../../platform/pathCompletion';

// A small site: /inc/db.asp, /inc/lib/, /index.asp and a hidden file.
describe('pathCompletions', () => {
    let site: string;

    before(() => {
        site = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-paths-'));
        fs.mkdirSync(path.join(site, 'inc', 'lib'), { recursive: true });
        fs.writeFileSync(path.join(site, 'inc', 'db.asp'), '');
        fs.writeFileSync(path.join(site, 'index.asp'), '');
        fs.writeFileSync(path.join(site, '.hidden'), '');
    });

    after(() => { fs.rmSync(site, { recursive: true, force: true }); });

    const labels = (list: vscode.CompletionList) => list.items.map(item => String(item.label));

    it('lists folders first, then files, leaving out hidden ones', async () => {
        const list = await pathCompletions(new vscode.Position(0, 10), '', site, 'File');
        assert.deepStrictEqual(labels(list).sort(), ['inc', 'index.asp']);
        const inc = list.items.find(item => item.label === 'inc')!;
        assert.strictEqual(inc.insertText, 'inc/');
        assert.ok(inc.sortText! < list.items.find(item => item.label === 'index.asp')!.sortText!);
        assert.strictEqual(list.isIncomplete, true);
    });

    it('reads the folder already typed, and replaces only the last segment', async () => {
        const list = await pathCompletions(new vscode.Position(3, 20), 'inc/d', site, 'Include file');
        assert.deepStrictEqual(labels(list).sort(), ['db.asp', 'lib']);
        const db = list.items.find(item => item.label === 'db.asp')!;
        assert.strictEqual(db.detail, 'Include file');
        const range = db.range as vscode.Range;
        assert.deepStrictEqual([range.start.character, range.end.character], [19, 20]);
    });

    it('reads a path that starts with / from the site root, not the drive root', async () => {
        const list = await pathCompletions(new vscode.Position(0, 5), '/inc/', site, 'Include file');
        assert.deepStrictEqual(labels(list).sort(), ['db.asp', 'lib']);
    });

    it('offers nothing for a folder that is not there', async () => {
        const list = await pathCompletions(new vscode.Position(0, 5), 'nope/', site, 'File');
        assert.deepStrictEqual(labels(list), []);
    });
});
