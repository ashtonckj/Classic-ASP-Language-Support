import * as assert from 'assert';
import { buildCssDoc, getInlineStyleContext, buildInlineCssDoc } from '../../utils/cssUtils';

// buildCssDoc must find the <style> block regardless of tag case (A4), otherwise
// CSS IntelliSense is silently dead inside <STYLE> blocks even though getZone
// (correctly, after A9) reports the position as the CSS zone.

describe('buildCssDoc — case-insensitive <style> (A4)', () => {
    it('builds a CSS doc inside an uppercase <STYLE> block', () => {
        const content = '<STYLE>\n.a { color: red; }\n</STYLE>';
        const offset = content.indexOf('color');
        const doc = buildCssDoc('file:///x.asp', content, 1, offset);
        assert.ok(doc !== null, 'expected a CSS doc for uppercase <STYLE>');
    });

    it('builds a CSS doc inside a lowercase <style> block (unchanged)', () => {
        const content = '<style>\n.a { color: red; }\n</style>';
        const offset = content.indexOf('color');
        assert.ok(buildCssDoc('file:///x.asp', content, 1, offset) !== null);
    });

    it('tolerates whitespace in the closing tag', () => {
        const content = '<style>\n.a { color: red; }\n</style >';
        const offset = content.indexOf('color');
        assert.ok(buildCssDoc('file:///x.asp', content, 1, offset) !== null);
    });

    it('returns null when the offset is outside any style block', () => {
        const content = '<p>hi</p>';
        assert.strictEqual(buildCssDoc('file:///x.asp', content, 1, 2), null);
    });

    // The end of the opening <style …> tag must be found by skipping ASP blocks
    // and quoted attribute values, not by grabbing the first '>' (which may be
    // the '>' of a %> or a '>' inside an attribute string). Otherwise the virtual
    // CSS document starts with leftover markup and every block reports false CSS
    // errors. (Author-reported edge cases.)
    it('finds the tag end past an ASP expression in an attribute', () => {
        const content = '<style type="<%= t %>">\n.a { color: red }\n</style>';
        const doc = buildCssDoc('file:///x.asp', content, 1, content.indexOf('color'));
        assert.ok(doc, 'expected a CSS doc');
        const css = doc!.getText().trimStart();
        assert.ok(
            css.startsWith('.a'),
            `CSS should start at the real tag end; got ${JSON.stringify(css.slice(0, 24))}`,
        );
    });

    it('finds the tag end past a > inside a quoted attribute value', () => {
        const content = '<style title="a > b">\n.a { color: red }\n</style>';
        const doc = buildCssDoc('file:///x.asp', content, 1, content.indexOf('color'));
        assert.ok(doc, 'expected a CSS doc');
        const css = doc!.getText().trimStart();
        assert.ok(
            css.startsWith('.a'),
            `CSS should start at the real tag end; got ${JSON.stringify(css.slice(0, 24))}`,
        );
    });

    it('finds the tag end past an ASP expression that emits a quote and >', () => {
        const content = '<style title="<%= ">" %>">\n.a { color: red }\n</style>';
        const doc = buildCssDoc('file:///x.asp', content, 1, content.indexOf('color'));
        assert.ok(doc, 'expected a CSS doc');
        const css = doc!.getText().trimStart();
        assert.ok(
            css.startsWith('.a'),
            `CSS should start at the real tag end; got ${JSON.stringify(css.slice(0, 24))}`,
        );
    });

    it('returns null when the offset is inside the opening tag', () => {
        const content = '<style type="text/css">.a{}</style>';
        assert.strictEqual(buildCssDoc('file:///x.asp', content, 1, content.indexOf('type')), null);
    });
});

// The inline style="" IntelliSense path (used by css hover/completion/diagnostics)
// has no getZone coverage, so exercise it directly here.
describe('inline style="" context (getInlineStyleContext / buildInlineCssDoc)', () => {
    it('locates the value range for a non-empty inline style', () => {
        const content = '<p style="color: red">hi</p>';
        const ctx = getInlineStyleContext(content, content.indexOf('red'));
        assert.ok(ctx, 'expected an inline context');
        assert.strictEqual(content.slice(ctx!.valueStart, ctx!.valueEnd), 'color: red');
    });

    it('handles an empty inline style value', () => {
        const content = '<p style="">hi</p>';
        const off = content.indexOf('""') + 1; // the closing quote
        const ctx = getInlineStyleContext(content, off);
        assert.ok(ctx, 'expected an inline context for empty value');
        assert.strictEqual(ctx!.valueStart, ctx!.valueEnd);
    });

    it('returns null when the cursor is not inside a style attribute', () => {
        const content = '<p>hello</p>';
        assert.strictEqual(getInlineStyleContext(content, content.indexOf('hello')), null);
    });

    it('buildInlineCssDoc wraps the declarations in a ruleset', () => {
        const content = '<p style="color: red">hi</p>';
        const ctx = getInlineStyleContext(content, content.indexOf('red'))!;
        const doc = buildInlineCssDoc('file:///x.asp', content, 1, ctx.valueStart, ctx.valueEnd);
        assert.ok(doc.getText().includes('color: red'));
    });
});
