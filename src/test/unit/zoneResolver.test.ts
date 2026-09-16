import * as assert from 'assert';
import { getZone, createZoneResolver, Zone } from '../../utils/zoneUtils';

// createZoneResolver exists purely to make classifying EVERY line of a document
// affordable — getZone rescans from offset 0 on each call, so asking it per line
// is quadratic (an 8,000-line <script> block cost ~11s to parse).
//
// The resolver is only safe if it is indistinguishable from getZone. So rather
// than testing hand-picked positions, each document below is checked at EVERY
// offset. Any divergence anywhere — a boundary off by one, a precedence rule
// applied in the wrong order — fails the test with the exact offset.

const DOCUMENTS: Record<string, string> = {
    'plain html': '<html>\n<body>\n<p>hello</p>\n</body>\n</html>\n',

    'one-line and multi-line asp blocks': [
        '<%@ LANGUAGE="VBSCRIPT" %>',
        '<html>',
        '<% Dim a %>',
        '<body>',
        '<%',
        '  Dim total',
        '  total = 1',
        '%>',
        '<p>Total: <%= total %></p>',
        '</body>',
        '</html>',
        '',
    ].join('\n'),

    'css and js blocks': [
        '<html>',
        '<style>',
        '  .a { color: red; }',
        '</style>',
        '<script>',
        '  function go() { return 1; }',
        '</script>',
        '</html>',
        '',
    ].join('\n'),

    // The reason a naive "inside a <script> means skip it" shortcut is wrong:
    // server-side ASP can sit inside a script block, and stays an ASP zone.
    'asp block nested inside a script block': [
        '<script>',
        'var x = 1;',
        '<%',
        '  Response.Write "y"',
        '%>',
        'var z = 2;',
        '</script>',
        '',
    ].join('\n'),

    'server-side vbscript script block': [
        '<script language="vbscript" runat="server">',
        '  Dim serverSide',
        '</script>',
        '<script>',
        '  var clientSide = 1;',
        '</script>',
        '',
    ].join('\n'),

    'non-js script type is html, not js': [
        '<script type="text/template">',
        '  <div>{{ name }}</div>',
        '</script>',
        '',
    ].join('\n'),

    'unclosed asp block runs to end of file': '<html>\n<%\nDim x\n',

    'unclosed script block runs to end of file': '<html>\n<script>\nvar x = 1;\n',

    'tag with > and %> inside attribute values': [
        '<div title="a > b">',
        '<style type="<%= cssType %>">',
        '  .b { color: blue; }',
        '</style>',
        '',
    ].join('\n'),

    'script mentioned inside a comment and a vb string': [
        '<!-- <script>not real</script> -->',
        '<%',
        '  x = "<script>also not real</script>"',
        '%>',
        '<script>',
        '  var real = 1;',
        '</script>',
        '',
    ].join('\n'),

    'literal < in body text': '<div>\n  Total: 5 < 10 and rising\n</div>\n<script>\nvar a = 1;\n</script>\n',

    'uppercase and spaced closing tags': '<STYLE>\n.c { color: green; }\n</STYLE >\n<SCRIPT>\nvar b = 2;\n</SCRIPT>\n',
};

describe('createZoneResolver — agrees with getZone at every offset', () => {
    for (const [name, text] of Object.entries(DOCUMENTS)) {
        it(name, () => {
            const resolver = createZoneResolver(text);
            for (let offset = 0; offset <= text.length; offset++) {
                const expected: Zone = getZone(text, offset);
                const actual: Zone   = resolver.zoneAt(offset);
                assert.strictEqual(
                    actual, expected,
                    `offset ${offset} (${JSON.stringify(text.slice(Math.max(0, offset - 12), offset))}`
                    + `|${JSON.stringify(text.slice(offset, offset + 12))}): `
                    + `resolver said ${actual}, getZone said ${expected}`,
                );
            }
        });
    }

    it('answers without rescanning — 40k of JavaScript stays fast', () => {
        const js: string[] = [];
        for (let i = 0; i < 4000; i++) { js.push(`  var v${i} = ${i};`); }
        const text = `<html>\n<script>\n${js.join('\n')}\n</script>\n</html>\n`;

        const started  = Date.now();
        const resolver = createZoneResolver(text);
        for (let line = 0; line < 4000; line++) { resolver.zoneAt(line * 20); }
        const elapsed = Date.now() - started;

        // getZone per line on this document takes seconds; the ceiling here is
        // deliberately loose so the test measures the algorithm, not the machine.
        assert.ok(elapsed < 500, `expected well under 500ms, took ${elapsed}ms`);
    });
});
