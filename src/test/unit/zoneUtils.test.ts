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

describe('getZone — lexical ASP block boundaries (A8)', () => {
    it('treats code before the first %> as the ASP zone', () => {
        const text = '<% x = "a%>b" %>';
        assert.strictEqual(getZone(text, text.indexOf('x')), 'asp');
    });

    it('treats a %> inside a string as closing the block (first %> wins)', () => {
        const text = '<% x = "a%>b" %>';
        // The `b` sits after the in-string %>, so per ASP it is NOT script.
        assert.notStrictEqual(getZone(text, text.indexOf('b')), 'asp');
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
        // block (the block ended at that %>), so it is HTML, not asp.
        const afterInStringClose = text.indexOf('%>') + 2;
        assert.notStrictEqual(getZone(text, afterInStringClose), 'asp');

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

describe('getZone — HTML tags are case-insensitive (A9)', () => {
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
});
