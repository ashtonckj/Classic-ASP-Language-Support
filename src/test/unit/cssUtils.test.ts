import * as assert from 'assert';
import { buildInlineCssDoc, stripAspExpressions, styleAttributeAt } from '../../css/cssUtils';
import { createZoneResolver } from '../../core/zoneUtils';

// The ASP→placeholder swap must preserve BOTH length and interior
// newlines, or CSS diagnostics after the expression land on the wrong line/column
// (they are mapped back by (line, character) identity).
describe('stripAspExpressions — length + newline preserving', () => {
    it('keeps the exact length for a single-line expression', () => {
        const input = '.a { color: <%= c %>; }';
        const out   = stripAspExpressions(input);
        assert.strictEqual(out.length, input.length);
        assert.ok(!out.includes('<%'), `ASP must be removed; got ${JSON.stringify(out)}`);
    });

    it('preserves interior newlines of a multi-line expression', () => {
        const input = '.a {\n  width: <%= GetW()\n             %>px;\n  colr: red;\n}';
        const out   = stripAspExpressions(input);
        assert.strictEqual(out.length, input.length, 'length must match');
        assert.strictEqual(
            (out.match(/\n/g) ?? []).length,
            (input.match(/\n/g) ?? []).length,
            'newline count must match so line numbers stay aligned',
        );
        // The `colr` typo must remain on the same line index as in the input.
        assert.strictEqual(
            out.split('\n').findIndex(l => l.includes('colr')),
            input.split('\n').findIndex(l => l.includes('colr')),
        );
    });

    it('keeps a CRLF and blanks a block left unclosed, as the HTML service is given them', () => {
        assert.strictEqual(stripAspExpressions('a {\r\n color: <%= c\r\n%>; }'), 'a {\r\n color: aaaaa\r\naa; }');
        assert.strictEqual(stripAspExpressions('a { color: <%= c'), 'a { color: aaaaa');
    });

    it('keeps a hex placeholder the same length', () => {
        const input = 'color:#<%=c%>;';
        assert.strictEqual(stripAspExpressions(input).length, input.length);
    });

    it('keeps an rgb() argument placeholder the same length', () => {
        const input = 'color: rgb(<%= r %>, 0, 0);';
        assert.strictEqual(stripAspExpressions(input).length, input.length);
    });
});

// The <style> body every CSS feature reads is the zone map's, found whatever
// the tag's case, and starting at the opening tag's real end: past an ASP
// expression or a > in an attribute value, which would otherwise leave markup
// at the start of the CSS and a false error on every block.
describe('<style> bodies', () => {
    const body = (content: string) => {
        const [range] = createZoneResolver(content).cssBlocks;
        return range && content.slice(range.start, range.end);
    };

    it('reads an uppercase <STYLE> block and a spaced closing tag', () => {
        assert.strictEqual(body('<STYLE>\n.a { color: red; }\n</STYLE>'), '\n.a { color: red; }\n');
        assert.strictEqual(body('<style>\n.a { color: red; }\n</style >'), '\n.a { color: red; }\n');
    });

    it('starts past an ASP expression in an attribute', () => {
        assert.strictEqual(body('<style type="<%= t %>">\n.a { color: red }\n</style>'), '\n.a { color: red }\n');
    });

    it('starts past a > inside a quoted attribute value', () => {
        assert.strictEqual(body('<style title="a > b">\n.a { color: red }\n</style>'), '\n.a { color: red }\n');
    });

    it('starts past an ASP expression that emits a quote and >', () => {
        assert.strictEqual(body('<style title="<%= ">" %>">\n.a { color: red }\n</style>'), '\n.a { color: red }\n');
    });
});

// The style="" values every CSS feature reads: the page's own attributes only.
describe('styleAttributeAt', () => {
    const valueAt = (content: string, offset: number) => {
        const value = styleAttributeAt(createZoneResolver(content), offset);
        return value && content.slice(value.start, value.end);
    };

    it('locates the value range for a non-empty inline style', () => {
        const content = '<p style="color: red">hi</p>';
        assert.strictEqual(valueAt(content, content.indexOf('red')), 'color: red');
    });

    it('is not fooled by data-style, or by a quote inside an ASP block', () => {
        const data = '<div data-style="primary large">x</div>';
        assert.strictEqual(valueAt(data, data.indexOf('large')), undefined);

        const asp = '<p style="color:<%= c("x") %>; width:1px">hi</p>';
        assert.strictEqual(valueAt(asp, asp.indexOf('width')), 'color:<%= c("x") %>; width:1px');
    });

    it('handles an empty inline style value', () => {
        const content = '<p style="">hi</p>';
        assert.strictEqual(valueAt(content, content.indexOf('""') + 1), '');
    });

    it('returns nothing when the cursor is not inside a style attribute', () => {
        const content = '<p>hello</p>';
        assert.strictEqual(valueAt(content, content.indexOf('hello')), undefined);
    });

    it('treats a > inside the style value as text, not a tag boundary', () => {
        const content = `<div style="content: '>'; color: red">x</div>`;
        assert.strictEqual(valueAt(content, content.indexOf('color')), "content: '>'; color: red");
    });

    it('resolves the SECOND style="" on a line (nearest, not first)', () => {
        const content = '<td style="width:10px">a</td><td style="color:re">b</td>';
        assert.strictEqual(valueAt(content, content.indexOf('color:re') + 'color:re'.length), 'color:re');
    });

    it('finds a value however far back its attribute starts', () => {
        const content = `<p style="${'margin: 0; '.repeat(80)}color: red">x</p>`;
        assert.ok(valueAt(content, content.indexOf('color: red'))?.endsWith('color: red'));
    });

    it('is nothing in a VBScript or JavaScript string, a comment, or the ASP inside a value', () => {
        for (const content of [
            '<% Response.Write "<p style=""color: red"">" %>',
            '<script>var t = \'<p style="color: red">\';</script>',
            '<!-- <p style="color: red"> -->',
            '<p style="color: <%= red %>">',
        ]) {
            assert.strictEqual(valueAt(content, content.indexOf('red')), undefined, content);
        }
    });

    it('buildInlineCssDoc wraps the declarations in a ruleset', () => {
        const content = '<p style="color: red">hi</p>';
        const value = styleAttributeAt(createZoneResolver(content), content.indexOf('red'))!;
        const doc = buildInlineCssDoc('file:///x.asp', content, 1, value.start, value.end);
        assert.ok(doc.getText().includes('color: red'));
    });
});