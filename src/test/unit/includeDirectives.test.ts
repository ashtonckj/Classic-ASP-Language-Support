import * as assert from 'assert';
import * as path from 'path';
import { movedPathLookup, rewriteIncludesAfterMove } from '../../utils/includeDirectives';

// Moving a file left every #include that named it pointing at nothing. These
// work out what each directive has to say instead.
const ROOT = path.resolve(path.sep, 'site');
const at   = (...parts: string[]) => path.join(ROOT, ...parts);

describe('movedPathLookup', () => {
    const moved = movedPathLookup([
        { oldPath: at('lib', 'db.asp'), newPath: at('inc', 'db.asp') },
        { oldPath: at('old'),           newPath: at('new') },
    ]);

    it('maps a moved file, without regard to case', () => {
        assert.strictEqual(moved(at('lib', 'db.asp')), at('inc', 'db.asp'));
        assert.strictEqual(moved(at('LIB', 'DB.asp')), at('inc', 'db.asp'));
    });

    it('maps everything under a moved folder, but not a folder that only starts the same', () => {
        assert.strictEqual(moved(at('old', 'a', 'x.asp')), at('new', 'a', 'x.asp'));
        assert.strictEqual(moved(at('older', 'x.asp')), undefined);
    });

    it('is undefined for a path that did not move', () => {
        assert.strictEqual(moved(at('page.asp')), undefined);
    });
});

describe('rewriteIncludesAfterMove', () => {
    const everything = () => true;

    function rewrite(
        text: string,
        renames: { oldPath: string; newPath: string }[],
        doc: { old: string; now?: string } = { old: at('page.asp') },
    ): string {
        const edits = rewriteIncludesAfterMove(
            text, doc.old, doc.now ?? doc.old, ROOT, movedPathLookup(renames), everything,
        );
        let result = text;
        for (const e of [...edits].reverse()) { result = result.slice(0, e.start) + e.newPath + result.slice(e.end); }
        return result;
    }

    it('points a file include at where its file went', () => {
        const text = '<!--#include file="lib/db.asp"-->';
        assert.strictEqual(
            rewrite(text, [{ oldPath: at('lib', 'db.asp'), newPath: at('inc', 'data', 'db.asp') }]),
            '<!--#include file="inc/data/db.asp"-->',
        );
    });

    it('points a virtual include at where its file went, from the site root', () => {
        const text = '<!--#include virtual="/lib/db.asp"-->';
        assert.strictEqual(
            rewrite(text, [{ oldPath: at('lib', 'db.asp'), newPath: at('inc', 'db.asp') }], { old: at('admin', 'page.asp') }),
            '<!--#include virtual="/inc/db.asp"-->',
        );
    });

    it("fixes a moved page's own file includes, and leaves its virtual ones", () => {
        const text = '<!--#include file="lib/db.asp"-->\n<!--#include virtual="/lib/db.asp"-->';
        assert.strictEqual(
            rewrite(text, [{ oldPath: at('page.asp'), newPath: at('admin', 'page.asp') }],
                { old: at('page.asp'), now: at('admin', 'page.asp') }),
            '<!--#include file="../lib/db.asp"-->\n<!--#include virtual="/lib/db.asp"-->',
        );
    });

    it('keeps an include between two files that moved together in one folder', () => {
        const text = '<!--#include file="db.asp"-->';
        const renames = [{ oldPath: at('lib'), newPath: at('inc') }];
        assert.strictEqual(rewrite(text, renames, { old: at('lib', 'page.asp'), now: at('inc', 'page.asp') }), text);
    });

    it('follows a renamed folder, and keeps backslashes written with backslashes', () => {
        const text = '<!--#include file="lib\\db.asp"-->';
        assert.strictEqual(
            rewrite(text, [{ oldPath: at('lib'), newPath: at('shared') }]),
            '<!--#include file="shared\\db.asp"-->',
        );
    });

    it('leaves an include alone when nothing it depends on moved', () => {
        const text = '<!--#include file="lib/db.asp"-->';
        assert.strictEqual(rewrite(text, [{ oldPath: at('other.asp'), newPath: at('else.asp') }]), text);
    });

    it('leaves an include that no longer resolves to a file', () => {
        const text = '<!--#include file="lib/db.asp"-->';
        const edits = rewriteIncludesAfterMove(
            text, at('page.asp'), at('page.asp'), ROOT,
            movedPathLookup([{ oldPath: at('lib', 'db.asp'), newPath: at('inc', 'db.asp') }]),
            () => false,
        );
        assert.deepStrictEqual(edits, []);
    });
});
