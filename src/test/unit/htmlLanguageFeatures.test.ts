import * as assert from 'assert';
import { maskAspBlocks, vbScriptBalancedBetween } from '../../providers/htmlLanguageFeatures';

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

// Two tags with VBScript between them are one pair only when that VBScript is
// whole: with an If opened and not closed, or an Else of a block that started
// before, the end tag belongs to more than one start tag.
describe('vbScriptBalancedBetween', () => {
    const between = (text: string) => vbScriptBalancedBetween(text, text.indexOf('>') + 1, text.lastIndexOf('</'));

    it('is true with no VBScript, output expressions, or a whole If between', () => {
        assert.strictEqual(between('<div>x</div>'), true);
        assert.strictEqual(between('<div><%= x %></div>'), true);
        assert.strictEqual(between('<div><% If a Then %>x<% Else %>y<% End If %></div>'), true);
    });

    it('is false when the tags sit in different branches', () => {
        assert.strictEqual(between('<div class="y"><% End If %>content</div>'), false);
        assert.strictEqual(between('<div><% Else %></div>'), false);
    });

    it('is false for a loop opened between them and not closed', () => {
        assert.strictEqual(between('<li><% For Each x In list %></li>'), false);
    });
});
