import * as assert from 'assert';
import { getCSSLanguageService } from 'vscode-css-languageservice';
import { buildCssDoc, buildCssBodyDoc } from '../../utils/cssUtils';
import { pageOffset, pagePosition, type ParsedCssBlock } from '../../utils/cssPageStylesheet';
import { getCssBlockRanges } from '../../utils/zoneUtils';

// The colour provider and CSS validation used to call buildCssDoc once per
// <style> block. Each of those calls padded its block with a whitespace prefix
// as long as everything before it on the page, so the work grew with the number
// of blocks even when the CSS did not — 1 ms at one block, 198 ms at 160, for
// the same rules in the same size of file. buildCssBodyDoc drops the padding,
// and the callers shift the positions instead.
//
// Dropping the padding means the language service no longer knows where on the
// page a block sits, so every position it reports now depends on arithmetic
// that did not exist before. These compare the two builds directly: for each
// document the body-only build must find the same colours, covering the same
// page text, and raise the same diagnostics at the same page positions, as the
// padded build it replaced.
//
// A single document covering every block at once was tried first, and these
// tests are what rejected it: with it, an unterminated rule in one block
// swallowed the next and moved the "} expected" to the end of the block after
// the one that was actually missing its brace. Mid-edit, an unterminated rule
// is the normal state of a file rather than an edge case.

const cssService = getCSSLanguageService();
const URI = 'file:///page.asp';

interface Found { colours: string[]; diagnostics: string[] }

/** Line/character of a page offset, computed independently of the code under test. */
function lineChar(text: string, offset: number): { line: number; character: number } {
    const before = text.slice(0, offset);
    return {
        line: before.split('\n').length - 1,
        character: offset - (before.lastIndexOf('\n') + 1),
    };
}

/** What the padded per-block build found. Its offsets are already page offsets. */
function padded(text: string): Found {
    const colours: string[] = [];
    const diagnostics: string[] = [];

    for (const range of getCssBlockRanges(text)) {
        const doc = buildCssDoc(URI, text, 1, range.start);
        if (!doc) { continue; }
        const sheet = cssService.parseStylesheet(doc);

        for (const c of cssService.findDocumentColors(doc, sheet)) {
            const start = doc.offsetAt(c.range.start);
            const end = doc.offsetAt(c.range.end);
            colours.push(`${start}:${text.slice(start, end)}`);
        }
        for (const d of cssService.doValidation(doc, sheet)) {
            diagnostics.push(`${d.range.start.line}:${d.range.start.character} ${d.message}`);
        }
    }

    return { colours, diagnostics };
}

/** The same, from documents holding only each block's body. */
function bodyOnly(text: string): Found {
    const colours: string[] = [];
    const diagnostics: string[] = [];

    for (const range of getCssBlockRanges(text)) {
        const cssDoc = buildCssBodyDoc(URI, text, 1, range);
        const stylesheet = cssService.parseStylesheet(cssDoc);
        const block: ParsedCssBlock = { range, cssDoc, stylesheet };
        const blockStart = lineChar(text, range.start);

        for (const c of cssService.findDocumentColors(cssDoc, stylesheet)) {
            const start = pageOffset(block, cssDoc.offsetAt(c.range.start));
            const end = pageOffset(block, cssDoc.offsetAt(c.range.end));
            colours.push(`${start}:${text.slice(start, end)}`);
        }
        for (const d of cssService.doValidation(cssDoc, stylesheet)) {
            const s = pagePosition(blockStart, d.range.start);
            diagnostics.push(`${s.line}:${s.character} ${d.message}`);
        }
    }

    return { colours, diagnostics };
}

const CASES: Array<[string, string]> = [
    ['no style block at all',
        '<html><body><p>hi</p></body></html>'],

    ['one block',
        '<style>\n.a { color: #ff0000; }\n</style>\n'],

    ['a block on the very first line, so the first line needs a column shift',
        '<style>.a { color: #ff0000; }</style>\n'],

    ['two blocks with markup between them',
        '<style>\n.a { color: #ff0000; }\n</style>\n<p>text</p>\n<style>\n.b { color: #00ff00; }\n</style>\n'],

    ['five blocks',
        ['<html><body>',
            ...[0, 1, 2, 3, 4].flatMap(i => ['<style>', `.c${i} { color: rgb(${i * 10}, 0, 0); margin: ${i}px; }`, '</style>', `<div>${i}</div>`]),
            '</body></html>', ''].join('\n')],

    ['an unterminated rule in the first of two blocks',
        '<style>\n.a { color: #ff0000;\n</style>\n<p>x</p>\n<style>\n.b { color: #0000ff; }\n</style>\n'],

    ['a stray closing brace in the first block',
        '<style>\n.a { color: red; } }\n</style>\n<style>\n.b { color: blue; }\n</style>\n'],

    ['an unknown property, which must still be reported',
        '<style>\n.a { colr: red; }\n</style>\n'],

    ['an empty rule, which the linter warns about',
        '<style>\n.a { }\n</style>\n<style>\n.b { color: red; }\n</style>\n'],

    ['ASP expressions inside the CSS',
        '<style>\n.a { color: #<%= hex %>; width: <%= w %>px; }\n</style>\n'],

    ['an ASP expression in the opening tag',
        '<style type="<%= t %>">\n.a { color: #abcdef; }\n</style>\n'],

    ['a multi-line ASP expression inside the CSS',
        '<style>\n.a { color: <%\n  Response.Write c\n%>; }\n</style>\n'],

    ['a block that is never closed',
        '<style>\n.a { color: #123456; }\n'],

    ['rgb, rgba, hsl and a named colour across two blocks',
        '<style>\n.a { color: rgb(255,0,0); }\n.b { color: rgba(0,0,255,0.5); }\n</style>\n<style>\n.c { color: hsl(120,100%,50%); }\n.d { color: red; }\n</style>\n'],

    ['a block preceded by a lot of markup',
        '<html><body>\n' + '<div>filler</div>\n'.repeat(200) + '<style>\n.a { color: #ff00ff; }\n</style>\n</body></html>\n'],

    ['a block whose opening tag has a > inside an attribute',
        '<style title="a > b">\n.a { color: #00ffff; }\n</style>\n'],
];

describe('buildCssBodyDoc agrees with the padded build it replaced', () => {
    for (const [name, text] of CASES) {
        it(name, () => {
            const before = padded(text);
            const after = bodyOnly(text);

            assert.deepStrictEqual(after.colours, before.colours, 'colours');
            assert.deepStrictEqual(after.diagnostics, before.diagnostics, 'diagnostics');
        });
    }
});

describe('buildCssBodyDoc holds the block and nothing else', () => {

    it('carries the body verbatim, with none of the surrounding markup', () => {
        const text = '<p>SHOULD NOT APPEAR</p>\n<style>\n.a { color: red; }\n</style>\n';
        const [range] = getCssBlockRanges(text);
        const doc = buildCssBodyDoc(URI, text, 1, range);

        assert.strictEqual(doc.getText(), text.slice(range.start, range.end));
        assert.ok(!doc.getText().includes('SHOULD NOT APPEAR'));
    });

    it('costs the size of the block, not the size of the page', () => {
        const block = '<style>\n.a { color: red; }\n</style>';
        const short = block;
        const long = '<div>filler</div>\n'.repeat(500) + block;

        const shortDoc = buildCssBodyDoc(URI, short, 1, getCssBlockRanges(short)[0]);
        const longDoc = buildCssBodyDoc(URI, long, 1, getCssBlockRanges(long)[0]);

        // The padded build made the second of these ~9 KB longer than the first,
        // for the same two lines of CSS.
        assert.strictEqual(longDoc.getText(), shortDoc.getText());
    });

    it('keeps ASP expressions length-preserved so offsets still line up', () => {
        const text = '<style>\n.a { color: #<%= hex %>; }\n</style>\n';
        const [range] = getCssBlockRanges(text);
        const doc = buildCssBodyDoc(URI, text, 1, range);

        assert.strictEqual(doc.getText().length, range.end - range.start);
        assert.ok(!doc.getText().includes('<%'));
    });
});

describe('pagePosition', () => {

    it('shifts the first line by the block start column', () => {
        const start = { line: 4, character: 7 };
        assert.deepStrictEqual(
            pagePosition(start, { line: 0, character: 3 }),
            { line: 4, character: 10 },
        );
    });

    it('leaves later lines at their own column', () => {
        const start = { line: 4, character: 7 };
        assert.deepStrictEqual(
            pagePosition(start, { line: 2, character: 3 }),
            { line: 6, character: 3 },
        );
    });
});
