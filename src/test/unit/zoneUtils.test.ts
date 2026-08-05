import * as assert from 'assert';
import { getZone, findTagEnd } from '../../utils/zoneUtils';

// ─────────────────────────────────────────────────────────────────────────────
// ASP block-scanning is LEXICAL (verified against a live IIS/ASP engine):
// the first `%>` closes a `<% … %>` block, EVEN when it sits inside a VBScript
// string or comment. See plan finding A8.
//
//   <%
//   testing = "fahhh%>"
//   %>
//
// The real engine hands VBScript only `testing = "fahhh` and raises
// "800a0409 Unterminated string constant". Everything after the in-string `%>`
// is HTML. These tests lock that behaviour in so a future refactor can never
// accidentally make block-scanning string-aware.
// ─────────────────────────────────────────────────────────────────────────────

describe('getZone — lexical ASP block boundaries', () => {
    it('treats code before the first %> as the ASP zone', () => {
        const text = '<% x = "a%>b" %>';
        assert.strictEqual(getZone(text, text.indexOf('x')), 'asp');
    });

    it('treats a %> inside a string as closing the block (first %> wins)', () => {
        const text = '<% x = "a%>b" %>';
        // The `b` sits after the in-string %>, so the block has closed and `b`
        // is literal HTML output — the only ASP-correct answer.
        assert.strictEqual(getZone(text, text.indexOf('b')), 'html');
    });

    it("matches the author's fahhh%> reproduction", () => {
        const text = [
            '<!DOCTYPE html>',
            '<%',
            'testing = "fahhh%>"',
            '%>',
            '',
            '<html><body><p><%= testing %></p></body></html>',
        ].join('\n');

        // `testing =` is inside the first block → asp.
        assert.strictEqual(getZone(text, text.indexOf('testing =')), 'asp');

        // The closing quote right after the in-string %> is already outside the
        // block (the block ended at that %>), so it is HTML.
        const afterInStringClose = text.indexOf('%>') + 2;
        assert.strictEqual(getZone(text, afterInStringClose), 'html');

        // The later <%= … %> output expression is its own ASP block.
        assert.strictEqual(getZone(text, text.indexOf('<%= testing') + 4), 'asp');
    });

    it('keeps a plain multi-line block fully in the ASP zone', () => {
        const text = '<%\nDim x\nx = 1\n%>\n<p>hi</p>';
        assert.strictEqual(getZone(text, text.indexOf('Dim x')), 'asp');
        assert.strictEqual(getZone(text, text.indexOf('x = 1')), 'asp');
        assert.strictEqual(getZone(text, text.indexOf('<p>hi') + 1), 'html');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML tag names are case-insensitive, so <STYLE>/<SCRIPT> and their closing
// tags must be recognised regardless of case. See plan finding A9/A4.
// ─────────────────────────────────────────────────────────────────────────────

describe('getZone — HTML tags are case-insensitive', () => {
    it('detects CSS inside an uppercase <STYLE> block', () => {
        const text = '<STYLE>\n.a { color: red; }\n</STYLE>';
        assert.strictEqual(getZone(text, text.indexOf('color')), 'css');
    });

    it('ends the CSS zone at an uppercase </STYLE>', () => {
        const text = '<STYLE>.a{color:red}</STYLE><p>hi</p>';
        assert.strictEqual(getZone(text, text.indexOf('hi')), 'html');
    });

    it('detects JS inside an uppercase <SCRIPT> block', () => {
        const text = '<SCRIPT>\nvar x = 1;\n</SCRIPT>';
        assert.strictEqual(getZone(text, text.indexOf('var x')), 'js');
    });

    it('ends the JS zone at an uppercase </SCRIPT>', () => {
        const text = '<SCRIPT>var x=1;</SCRIPT><p>hi</p>';
        assert.strictEqual(getZone(text, text.indexOf('hi')), 'html');
    });

    it('tolerates whitespace in the closing tag (</style >)', () => {
        const text = '<style>.a{color:red}</style ><p>hi</p>';
        assert.strictEqual(getZone(text, text.indexOf('hi')), 'html');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The end of an opening tag (<style …>, <script …>) must be located by skipping
// ASP blocks and quoted attribute values — a `>` inside `%>` or inside an
// attribute string is NOT the tag terminator. And a closing tag that appears
// inside a `<% … %>` server block does not really close the element. (Author-
// reported edge cases.)
// ─────────────────────────────────────────────────────────────────────────────

describe('getZone — robust tag-boundary scanning', () => {
    it('keeps CSS content in the css zone when the tag has an ASP attribute', () => {
        const text = '<style type="<%= t %>">\n.a { color: red }\n</style>';
        assert.strictEqual(getZone(text, text.indexOf('color')), 'css');
    });

    it('keeps JS content in the js zone when the tag has an ASP attribute', () => {
        const text = '<script src="<%= u %>">\nvar x = 1;\n</script>';
        assert.strictEqual(getZone(text, text.indexOf('var x')), 'js');
    });

    it('does not let a </style> inside a <% %> block close the element early', () => {
        const text = '<style>.a{}<% x = "</style>" %>.b{color:red}</style>';
        assert.strictEqual(getZone(text, text.indexOf('.b')), 'css');
    });

    // A <script>/<style> inside a VBScript string or comment is data, not markup.
    // It must never open a JS/CSS zone — otherwise ASP that emits HTML via strings
    // (very common) floods the file with bogus JS/CSS diagnostics.
    it('does NOT treat <script> emitted via Response.Write as a tag', () => {
        const text = '<%\nResponse.Write "<script>alert(1)</script>"\nDim x\n%>\n<p>ok</p>';
        // The <script> lives inside a VBScript string in the block → asp, not js.
        assert.strictEqual(getZone(text, text.indexOf('alert')), 'asp');
        // Real VBScript after the string stays asp; nothing becomes a JS zone.
        assert.strictEqual(getZone(text, text.indexOf('Dim x')), 'asp');
        // Markup after the block closes is html.
        assert.strictEqual(getZone(text, text.indexOf('<p>ok') + 1), 'html');
    });

    it('does NOT treat <style> emitted via Response.Write as a tag', () => {
        const text = '<% Response.Write "<style>.a{}</style>" %><p>ok</p>';
        assert.strictEqual(getZone(text, text.indexOf('.a{')), 'asp');
        assert.strictEqual(getZone(text, text.indexOf('<p>ok') + 1), 'html');
    });

    it('does NOT treat a <script> inside a VBScript string as a tag (even with an in-string %>)', () => {
        const text = '<% s = "%><script>" %>var zz=1;';
        assert.notStrictEqual(getZone(text, text.indexOf('zz')), 'js');
    });

    it('does NOT treat a <style> inside a VBScript string as a tag (even with an in-string %>)', () => {
        const text = '<% s = "%><style>" %>.x{color:red}';
        assert.notStrictEqual(getZone(text, text.indexOf('.x')), 'css');
    });

    it('does NOT treat a <script> inside a VBScript comment as a tag', () => {
        const text = '<%\n\' see <script> in the docs\nDim x\n%>\n<p>ok</p>';
        assert.strictEqual(getZone(text, text.indexOf('Dim x')), 'asp');
        assert.strictEqual(getZone(text, text.indexOf('<p>ok') + 1), 'html');
    });

    // ...but a real <style>/<script> AFTER a one-line <% ' comment %> block must
    // still be detected (the %> closes the block even though it sits mid-comment).
    it('still detects a real <style> after a one-line <% ... %> comment block', () => {
        const text = "<% ' cmt %><style>.y{color:red}</style>";
        assert.strictEqual(getZone(text, text.indexOf('.y')), 'css');
    });
});

describe('findTagEnd — opening-tag terminator', () => {
    it('returns the plain > for a simple tag', () => {
        const tag = '<script>';
        assert.strictEqual(findTagEnd(tag, 0), tag.indexOf('>'));
    });

    it('skips a > inside a quoted attribute value', () => {
        const tag = '<style title="a > b">rest';
        // The real terminator is the > right before "rest", not the one in "a > b".
        assert.strictEqual(findTagEnd(tag, 0), tag.indexOf('>rest'));
    });

    it('skips the > of a %> inside an ASP attribute expression', () => {
        const tag = '<script src="<%= u %>">rest';
        assert.strictEqual(findTagEnd(tag, 0), tag.indexOf('>rest'));
    });

    it('returns -1 for an unterminated ASP block in the tag', () => {
        const tag = '<script src="<%= u ';
        assert.strictEqual(findTagEnd(tag, 0), -1);
    });

    it('skips an ASP block even when it opens inside an attribute value', () => {
        // The > inside the ASP expression's string (">") must not end the tag;
        // the real end is the > after the attribute-closing quote.
        const tag = '<style title="<%= ">" %>">rest';
        assert.strictEqual(findTagEnd(tag, 0), tag.indexOf('>rest'));
    });
});

describe('getZone — <script> type/language discrimination', () => {
    it('treats <script type="text/vbscript"> as the asp zone', () => {
        const text = '<script type="text/vbscript">\nx = 1\n</script>';
        assert.strictEqual(getZone(text, text.indexOf('x = 1')), 'asp');
    });

    it('treats <script language="vbscript"> as the asp zone', () => {
        const text = '<script language="vbscript">\nx = 1\n</script>';
        assert.strictEqual(getZone(text, text.indexOf('x = 1')), 'asp');
    });

    it('treats an uppercase server-side VBScript block as the asp zone', () => {
        const text = '<SCRIPT LANGUAGE="VBScript" RUNAT="SERVER">\nx = 1\n</SCRIPT>';
        assert.strictEqual(getZone(text, text.indexOf('x = 1')), 'asp');
    });

    it('treats a known non-JS <script type> (text/template) as html, not js', () => {
        const text = '<script type="text/template">\n<div>{{x}}</div>\n</script>';
        assert.strictEqual(getZone(text, text.indexOf('<div>') + 1), 'html');
    });
});

describe('getZone — boundaries and multiple blocks', () => {
    it('classifies the exact <% / %> delimiter offsets', () => {
        const text = '<% x = 1 %>after';
        assert.strictEqual(getZone(text, 0), 'html');  // on the '<' of <%
        assert.strictEqual(getZone(text, 1), 'asp');   // between '<' and '%'
        assert.strictEqual(getZone(text, 10), 'asp');  // on the '>' of %>
        assert.strictEqual(getZone(text, 11), 'html'); // first char after %>
    });

    it('handles multiple <style> blocks and the gap between them', () => {
        const text = '<style>.a{}</style><p>x</p><style>.b{color:red}</style>';
        assert.strictEqual(getZone(text, text.indexOf('.b')), 'css');
        assert.strictEqual(getZone(text, text.indexOf('<p>x') + 1), 'html');
    });

    it('reports html when the cursor is inside the opening <style ...> tag', () => {
        const text = '<style type="text/css">.a{}</style>';
        assert.strictEqual(getZone(text, text.indexOf('type')), 'html');
    });
});
