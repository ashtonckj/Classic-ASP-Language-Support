import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    indexOfWholeWord,
    aspCodeStartOnLine,
    isInsideTagForAttributes,
    getCurrentTagName,
} from '../../platform/documentHelper';

// Minimal TextDocument stand-in: the tag scanners only need getText/offsetAt.
function docAt(text: string): { document: vscode.TextDocument; posOf: (marker: string) => vscode.Position } {
    const lines = text.split(String.fromCharCode(10));
    const document = {
        getText:   () => text,
        lineCount: lines.length,
        lineAt:    (n: number) => ({ text: lines[n] }),
        offsetAt:  (p: { line: number; character: number }) =>
            lines.slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + p.character,
    } as unknown as vscode.TextDocument;

    // Position of the '|' caret marker's slot, given the marker text preceding it.
    const posOf = (marker: string) => {
        const abs = text.indexOf(marker) + marker.length;
        let line = 0, rest = abs;
        while (rest > lines[line].length) { rest -= lines[line].length + 1; line++; }
        return { line, character: rest } as vscode.Position;
    };
    return { document, posOf };
}

describe('indexOfWholeWord', () => {
    it('finds the standalone word, not a substring in a longer identifier', () => {
        assert.strictEqual(indexOfWholeWord('Dim accountCount, count', 'count'), 18);
    });
    it('is case-insensitive', () => {
        assert.strictEqual(indexOfWholeWord('Dim Total', 'total'), 4);
    });
    it('returns -1 when the whole word is absent', () => {
        assert.strictEqual(indexOfWholeWord('Dim accountCounter', 'count'), -1);
    });
});

// A physical line can mix HTML and VBScript. Any line-local scan for strings or
// `'` comments has to begin at the script, or an apostrophe in the HTML part
// ("it's", class='box') reads as a comment marker and silently switches off
// completion, go-to-definition, hover and rename for the rest of the line.
describe('aspCodeStartOnLine', () => {
    it('returns 0 for a line with no <% (inside a multi-line block)', () => {
        assert.strictEqual(aspCodeStartOnLine('  total = total + 1', 19), 0);
    });

    it('starts after the <% of an inline block', () => {
        const line = "<td>it's here</td><% total = 1 %>";
        assert.strictEqual(aspCodeStartOnLine(line, line.indexOf('total')), line.indexOf('<%') + 2);
    });

    it('skips the marker of an output expression', () => {
        const line = '<td><%= total %></td>';
        assert.strictEqual(aspCodeStartOnLine(line, line.indexOf('total')), line.indexOf('<%=') + 3);
    });

    it('tracks the second block when a line has two', () => {
        const line = '<% a = 1 %> plain <% b = 2 %>';
        assert.strictEqual(aspCodeStartOnLine(line, line.indexOf('b =')), line.lastIndexOf('<%') + 2);
    });

    it('never returns past the column asked about', () => {
        const line = '<% x = 1 %>';
        assert.strictEqual(aspCodeStartOnLine(line, 1), 1);
    });
});

// Attribute IntelliSense used to locate the enclosing tag by comparing
// lastIndexOf('<') with lastIndexOf('>'), so a '>' inside a quoted attribute
// value counted as the tag's end and attribute suggestions died for the rest of
// that tag.
describe('isInsideTagForAttributes / getCurrentTagName', () => {
    const check = (text: string, marker: string) => {
        const { document, posOf } = docAt(text);
        const position = posOf(marker);
        return {
            inside: isInsideTagForAttributes(document, position),
            tag:    getCurrentTagName(document, position),
        };
    };

    it('stays inside the tag past a > in a quoted attribute value', () => {
        const r = check('<a title="a > b" >', '<a title="a > b" ');
        assert.strictEqual(r.inside, true);
        assert.strictEqual(r.tag, 'a');
    });

    it('stays inside the tag past a JS comparison in an event handler', () => {
        const r = check('<div onclick="if(a>b)go()" >', '<div onclick="if(a>b)go()" ');
        assert.strictEqual(r.inside, true);
        assert.strictEqual(r.tag, 'div');
    });

    it('still works with no > in the value (the plain case)', () => {
        const r = check('<a title="a b" >', '<a title="a b" ');
        assert.strictEqual(r.inside, true);
        assert.strictEqual(r.tag, 'a');
    });

    it('still works with an ASP expression in the value', () => {
        const r = check('<input value="<%= x %>" />', '<input value="<%= x %>" ');
        assert.strictEqual(r.inside, true);
        assert.strictEqual(r.tag, 'input');
    });

    it('is outside once the tag has really closed', () => {
        const r = check('<a title="a > b">text', '<a title="a > b">');
        assert.strictEqual(r.inside, false);
        assert.strictEqual(r.tag, null);
    });

    it('is outside in plain body text', () => {
        const r = check('<p>hello world</p>', '<p>hello ');
        assert.strictEqual(r.inside, false);
    });

    it('is not fooled by a literal < in body text', () => {
        const r = check('<p>qty < 5</p>\n<div >', '<p>qty < 5</p>\n<div ');
        assert.strictEqual(r.inside, true);
        assert.strictEqual(r.tag, 'div');
    });

    it('is not fooled by < and > operators inside a <script> body', () => {
        const r = check('<script>\n  if (a<b) { }\n</script>\n<div >', '<div ');
        assert.strictEqual(r.inside, true);
        assert.strictEqual(r.tag, 'div');
    });

    it('ignores tags that only appear inside an HTML comment', () => {
        const r = check('<!-- <a title="x" -->\n<p>text', '<p>text');
        assert.strictEqual(r.inside, false);
    });

    it('reports the tag when the cursor sits between two attributes', () => {
        const r = check('<img src="a > b"  alt="x">', '<img src="a > b" ');
        assert.strictEqual(r.tag, 'img');
    });
});
