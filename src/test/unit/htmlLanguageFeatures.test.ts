import * as assert from 'assert';
import * as vscode from 'vscode';
import { fakeDocument } from './_helpers';
import { HtmlCompletionProvider } from '../../html/htmlCompletionProvider';
import { vbScriptBalancedBetween } from '../../html/htmlLanguageFeatures';
import { maskAsp } from '../../core/zoneUtils';
import { pageBlocks } from '../../vbscript/pageAnalysis';
import { parsePage } from '../../vbscript/symbols';

// The HTML language service reads the page with its ASP turned to spaces, so a
// `<%= x %>` is nothing to it, and every position still lines up.
describe('maskAsp', () => {
    it('turns each block to spaces of the same length', () => {
        const text = '<a href="<%= url %>">x</a>';
        const masked = maskAsp(text);
        assert.strictEqual(masked, `<a href="${' '.repeat('<%= url %>'.length)}">x</a>`);
        assert.strictEqual(masked.length, text.length);
    });

    it('keeps line breaks, CRLF included, and masks an unclosed block to the end', () => {
        assert.strictEqual(maskAsp('<p>\r\n<%\r\nIf a Then\r\n%>\r\n</p>'), '<p>\r\n  \r\n         \r\n  \r\n</p>');
        assert.strictEqual(maskAsp('<p><% x'), '<p>    ');
    });

    it('does not end a block at a %> inside a VBScript string', () => {
        assert.strictEqual(maskAsp('<% s = "%><b>" %><i>'), ' '.repeat(17) + '<i>');
    });
});

// Two tags with VBScript between them are one pair only when that VBScript is
// whole: with an If opened and not closed, or an Else of a block that started
// before, the end tag belongs to more than one start tag.
describe('vbScriptBalancedBetween', () => {
    const between = (text: string) => vbScriptBalancedBetween(text, text.indexOf('>') + 1, text.lastIndexOf('</'), pageBlocks(parsePage(text)).events);

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

// Tag, closing-tag and attribute suggestions, as a .html file gives them: read
// from the page's parse, so text in a comment, a script or a style is not markup.
describe('HtmlCompletionProvider', () => {
    const provider = new HtmlCompletionProvider();
    const labels = (text: string, trigger?: string): string[] => {
        const at = text.indexOf('|');
        const document = fakeDocument(text.replace('|', ''));
        const items = provider.provideCompletionItems(
            document as never, document.positionAt(at) as never, undefined as never,
            { triggerCharacter: trigger, triggerKind: trigger ? 1 : 0 } as never,
        ) as vscode.CompletionItem[];
        return items.map(item => String(item.label));
    };

    it('closes the element the parse says is open, not a tag in a comment, script or style', () => {
        assert.deepStrictEqual(labels('<div><!-- <p> -->\n</|', '/'), ['/div']);
        assert.deepStrictEqual(labels('<div><script>var s="<p>";</script>\n</|', '/'), ['/div']);
        assert.deepStrictEqual(labels('<div><style>.a::after{content:"<b>"}</style>\n</|', '/'), ['/div']);
    });

    it('closes a custom element', () => {
        assert.deepStrictEqual(labels('<my-el>\n</|', '/'), ['/my-el']);
    });

    it('offers no markup inside a comment', () => {
        assert.deepStrictEqual(labels('<!-- note: use <|', '<'), []);
    });

    it('does not take a <!-- in a script string or an attribute for a comment', () => {
        assert.ok(labels('<script>var s = "<!--";</script>\n<|', '<').includes('div'));
        assert.ok(labels('<a title="<!--">x</a>\n<|', '<').includes('div'));
    });

    it('offers attributes on a later line of a tag, leaving out the ones it has', () => {
        const offered = labels('<div\n  class="a"\n  |');
        assert.ok(offered.includes('id'), 'id');
        assert.ok(!offered.includes('class'), 'class is already on the tag');
    });
});
