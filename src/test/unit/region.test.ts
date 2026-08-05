import * as assert from 'assert';
import { findAspRegionOffsets } from '../../utils/region';

// The <% %> background-highlight regions are found by pairing each
// opener with its FIRST %> (like the ASP engine). A stray `%>` in HTML text must
// not be treated as an opener and shift the pairing of every real block.
describe('findAspRegionOffsets — lexical <% %> pairing', () => {
    const codeOf = (text: string, r: { code: [number, number] }) =>
        text.slice(r.code[0], r.code[1]);

    it('ignores a stray %> in HTML text', () => {
        const text    = '<p>Progress: 50%></p>\n<% x = 1 %>';
        const regions = findAspRegionOffsets(text);
        assert.strictEqual(regions.length, 1, 'only the real <% %> block is a region');
        assert.strictEqual(codeOf(text, regions[0]).trim(), 'x = 1');
    });

    it('pairs <%= with its first %>', () => {
        const text    = 'a<%= v %>b';
        const regions = findAspRegionOffsets(text);
        assert.strictEqual(regions.length, 1);
        assert.strictEqual(text.slice(regions[0].open[0], regions[0].open[1]), '<%=');
        assert.strictEqual(codeOf(text, regions[0]).trim(), 'v');
    });

    it('handles multiple blocks and stops cleanly at an unterminated one', () => {
        const text    = '<% a %>mid<% b %>tail<% c';
        const regions = findAspRegionOffsets(text);
        assert.strictEqual(regions.length, 2);
        assert.deepStrictEqual(regions.map(r => codeOf(text, r).trim()), ['a', 'b']);
    });

    it('treats the FIRST %> as the close, even one inside a string', () => {
        // Matches the lexical rule isInsideAspBlock uses.
        const text    = '<% x = "a %> b" %>';
        const regions = findAspRegionOffsets(text);
        assert.strictEqual(regions.length, 1);
        assert.strictEqual(codeOf(text, regions[0]), ' x = "a ');
    });
});
