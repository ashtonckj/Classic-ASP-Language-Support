import * as assert from 'assert';
import { createZoneResolver, Zone } from '../../core/zoneUtils';

// The zones of awkward pages: each marker's first character is in the zone given.

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

    'a style tag written inside a script string': [
        '<script>',
        '  var tpl = "<style>p { colr: red; }</style>";',
        '</script>',
        '<style>',
        '  a { color: red; }',
        '</style>',
        '',
    ].join('\n'),
};

describe('zones of a style tag inside a script', () => {
    it('is script text, and the real <style> after it is still CSS', () => {
        const text = DOCUMENTS['a style tag written inside a script string'];
        const resolver = createZoneResolver(text);
        assert.strictEqual(resolver.zoneAt(text.indexOf('colr')), 'js');
        assert.strictEqual(resolver.zoneAt(text.indexOf('color')), 'css');
        assert.strictEqual(resolver.cssBlocks.length, 1);
    });
});

describe('createZoneResolver — awkward pages', () => {
    const EXPECTED: Record<string, Array<[string, Zone]>> = {
        'plain html': [['hello', 'html'], ['</body>', 'html']],
        'one-line and multi-line asp blocks': [
            ['LANGUAGE', 'asp'], ['Dim a', 'asp'], ['Dim total', 'asp'], ['<p>Total', 'html'], ['total %>', 'asp'], ['</body>', 'html'],
        ],
        'css and js blocks': [['.a {', 'css'], ['function go', 'js'], ['</html>', 'html']],
        'asp block nested inside a script block': [['var x', 'js'], ['Response.Write', 'asp'], ['var z', 'js']],
        'server-side vbscript script block': [['Dim serverSide', 'asp'], ['var clientSide', 'js']],
        'non-js script type is html, not js': [['{{ name }}', 'html']],
        'unclosed asp block runs to end of file': [['Dim x', 'asp']],
        'unclosed script block runs to end of file': [['var x', 'js']],
        'tag with > and %> inside attribute values': [['a > b', 'html'], ['cssType', 'asp'], ['.b {', 'css']],
        'script mentioned inside a comment and a vb string': [['not real', 'html'], ['also not real', 'asp'], ['var real', 'js']],
        'literal < in body text': [['Total', 'html'], ['var a', 'js']],
        'uppercase and spaced closing tags': [['.c {', 'css'], ['var b', 'js']],
        'a style tag written inside a script string': [['colr', 'js'], ['a { color', 'css']],
    };

    for (const [name, text] of Object.entries(DOCUMENTS)) {
        it(name, () => {
            const resolver = createZoneResolver(text);
            for (const [marker, zone] of EXPECTED[name]) {
                assert.ok(text.includes(marker), marker);
                assert.strictEqual(resolver.zoneAt(text.indexOf(marker)), zone, marker);
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

        // A scan per question took seconds on this document; the ceiling here is
        // deliberately loose so the test measures the algorithm, not the machine.
        assert.ok(elapsed < 500, `expected well under 500ms, took ${elapsed}ms`);
    });
});
