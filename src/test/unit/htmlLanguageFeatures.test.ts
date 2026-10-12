import * as assert from 'assert';
import * as vscode from 'vscode';
import { fakeDocument } from './_helpers';
import { HtmlCompletionProvider } from '../../html/htmlCompletionProvider';
import { HtmlDocumentSymbolProvider, vbScriptBalancedBetween } from '../../html/htmlLanguageFeatures';
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

// The Outline of a .html file shows its element tree; a page's shows it too,
// with the ASP blanked so a <%= %> or a Response.Write string is not markup.
describe('HtmlDocumentSymbolProvider', () => {
    const PAGE = [
        '<%',
        'Sub WriteRow(id)',
        '    Response.Write "<tr><td>" & id & "</td></tr>"',
        'End Sub',
        '%>',
        '<html>',
        '<head><title><%= pageTitle %></title></head>',
        '<body>',
        '    <section id="orders" class="card">',
        '        <table><% WriteRow 1 %></table>',
        '    </section>',
        '    <script>function greet() {}</script>',
        '</body>',
        '</html>',
    ].join('\n');

    // Each symbol and the ones inside it, as `name(child, …)`; the stub
    // DocumentSymbol throws on a selection range outside the range.
    const tree = (symbols: vscode.DocumentSymbol[]): string =>
        symbols.map(s => s.children.length ? `${s.name}(${tree(s.children)})` : s.name).join(', ');

    it('gives the element tree, and nothing from the VBScript', () => {
        const symbols = new HtmlDocumentSymbolProvider().provideDocumentSymbols(fakeDocument(PAGE));
        assert.strictEqual(tree(symbols), 'html(head(title), body(section#orders.card(table), script))');
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

// Tag, closing-tag, attribute and value suggestions, as a .html file gives them:
// the HTML language service's, read from the page's parse, so text in a
// comment, a script or a style is not markup.
describe('HtmlCompletionProvider', () => {
    const provider = new HtmlCompletionProvider();
    const complete = (text: string): vscode.CompletionItem[] => {
        const at = text.indexOf('|');
        const document = fakeDocument(text.replace('|', ''));
        return provider.provideCompletionItems(document, document.positionAt(at))?.items ?? [];
    };
    const labels = (text: string): string[] => complete(text).map(item => String(item.label));

    it('closes the element the parse says is open, not a tag in a comment, script or style', () => {
        assert.deepStrictEqual(labels('<div><!-- <p> -->\n</|'), ['/div']);
        assert.deepStrictEqual(labels('<div><script>var s="<p>";</script>\n</|'), ['/div']);
        assert.deepStrictEqual(labels('<div><style>.a::after{content:"<b>"}</style>\n</|'), ['/div']);
    });

    it('closes a custom element', () => {
        assert.deepStrictEqual(labels('<my-el>\n</|'), ['/my-el']);
    });

    it('lines a closing tag up with its opening tag', () => {
        const [item] = complete('  <div>\n      </|');
        assert.strictEqual((item.insertText as vscode.SnippetString).value ?? item.insertText, '  </div>');
        assert.strictEqual((item.range as vscode.Range).start.character, 0);
    });

    it('offers no markup inside a comment', () => {
        assert.deepStrictEqual(labels('<!-- note: use <|'), []);
    });

    it('does not take a <!-- in a script string or an attribute for a comment', () => {
        assert.ok(labels('<script>var s = "<!--";</script>\n<|').includes('div'));
        assert.ok(labels('<a title="<!--">x</a>\n<|').includes('div'));
    });

    it('offers every element the HTML data knows, a closer for the open one first', () => {
        const offered = labels('<section>\n<|');
        for (const tag of ['div', 'template', 'picture', 'dialog', '/section']) { assert.ok(offered.includes(tag), tag); }
    });

    it('writes a picked tag whole, laid out by kind, unless the tag goes on after it', () => {
        const insert = (text: string, tag: string) => {
            const item = complete(text).find(i => i.label === tag);
            return item?.insertText instanceof vscode.SnippetString ? item.insertText.value : item?.insertText;
        };
        assert.strictEqual(insert('<p>Some text <|\n', 'span'), 'span>$0</span>');
        assert.strictEqual(insert('<p>Some text <|\n', 'div'), 'div>\n\t$0\n</div>');
        assert.strictEqual(insert('<p>Some text <|\n', 'br'), 'br $0/>');
        assert.strictEqual(insert('<di| class="a">', 'div'), 'div');
    });

    it('offers attributes on a later line of a tag, leaving out the ones it has', () => {
        const offered = labels('<div\n  class="a"\n  |');
        assert.ok(offered.includes('id'), 'id');
        assert.ok(!offered.includes('class'), 'class is already on the tag');
    });

    it("offers a tag's own attributes, and goes on to the values of one that has them", () => {
        const items = complete('<input |');
        assert.ok(items.some(i => i.label === 'autocomplete'), 'autocomplete');
        assert.strictEqual(items.find(i => i.label === 'type')?.command?.command, 'editor.action.triggerSuggest');
        assert.ok(labels('<input type="|">').includes('checkbox'));
    });

    // A `>` that is not the tag's end, ASP in the tag, or markup-like text
    // before it, must not end the tag early.
    it('stays inside the tag past a > in a value, an event handler, ASP, a < in text or a script', () => {
        for (const text of [
            '<a title="a > b" |>',
            '<a onclick="if(a>b)go()" |>',
            '<a title="<%= x %>" |>',
            '<p>qty < 5</p>\n<a |>',
            '<script>\n  if (a<b) { }\n</script>\n<a |>',
        ]) {
            assert.ok(labels(text).includes('href'), text);
        }
    });

    it('offers no attributes once the tag has closed', () => {
        assert.ok(!labels('<a title="a > b">text |').includes('href'));
    });

    it('offers nothing in the ASP inside a tag', () => {
        assert.deepStrictEqual(labels('<a title="<%= | %>">'), []);
    });
});