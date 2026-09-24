import * as assert from 'assert';
import { maskAspBlocks } from '../../providers/htmlLanguageFeatures';

// The HTML language service reads the page with its ASP turned to spaces, so a
// `<%= x %>` is nothing to it, and every position still lines up.
describe('maskAspBlocks', () => {
    it('turns each block to spaces of the same length', () => {
        const text = '<a href="<%= url %>">x</a>';
        const masked = maskAspBlocks(text);
        assert.strictEqual(masked, `<a href="${' '.repeat('<%= url %>'.length)}">x</a>`);
        assert.strictEqual(masked.length, text.length);
    });

    it('keeps line breaks, CRLF included, and masks an unclosed block to the end', () => {
        assert.strictEqual(maskAspBlocks('<p>\r\n<%\r\nIf a Then\r\n%>\r\n</p>'), '<p>\r\n  \r\n         \r\n  \r\n</p>');
        assert.strictEqual(maskAspBlocks('<p><% x'), '<p>    ');
    });
});
