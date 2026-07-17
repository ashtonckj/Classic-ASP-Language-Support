import * as assert from 'assert';
import { buildCssDoc } from '../../utils/cssUtils';

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
});
