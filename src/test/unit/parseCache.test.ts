import * as assert from 'assert';
import { ParseCache } from '../../vbscript/parseCache';

describe('ParseCache', () => {
    it('gives the same parse back while the text is the same, whatever the path case', () => {
        const cache = new ParseCache(10, 1000);
        const first = cache.parse('C:\\site\\a.asp', '<% x = 1 %>');
        assert.strictEqual(cache.parse('c:\\SITE\\a.asp', '<% x = 1 %>'), first);
        assert.notStrictEqual(cache.parse('C:\\site\\a.asp', '<% x = 2 %>'), first);
        assert.deepStrictEqual(cache.size, { files: 1, chars: '<% x = 2 %>'.length });
    });

    it('lets the least recently used file go when it holds too many', () => {
        const cache = new ParseCache(2, 1000);
        const a = cache.parse('a.asp', '<% a %>');
        cache.parse('b.asp', '<% b %>');
        cache.parse('a.asp', '<% a %>');          // a is now the most recent
        cache.parse('c.asp', '<% c %>');          // so b goes
        assert.strictEqual(cache.parse('a.asp', '<% a %>'), a);
        assert.strictEqual(cache.size.files, 2);
    });

    it('lets old files go when it holds too much text, but keeps the newest', () => {
        const cache = new ParseCache(10, 30);
        cache.parse('a.asp', '<% a = 1 %>');
        cache.parse('b.asp', '<% b = 1 %>');
        assert.strictEqual(cache.size.files, 2);
        cache.parse('big.asp', `<% x = "${'y'.repeat(50)}" %>`);
        assert.deepStrictEqual(cache.size.files, 1, 'one page larger than the bound is still kept');
    });
});
