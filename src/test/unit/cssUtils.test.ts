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
});
