import * as assert from 'assert';
import * as vscode from 'vscode';
import { STRUCTURAL_TAGS, scanHtmlStructure } from '../../providers/htmlStructureDiagnosticsProvider';

// Elements with OPTIONAL end tags (table cells/rows/sections) must not
// be tracked as "must be closed", or valid tables get flooded with false
// "Missing closing tag" warnings (which also block Format Document).
describe('STRUCTURAL_TAGS — optional-end-tag elements are excluded', () => {
    for (const tag of ['tr', 'td', 'th', 'thead', 'tbody', 'tfoot']) {
        it(`does not require a closing tag for <${tag}>`, () => {
            assert.ok(!STRUCTURAL_TAGS.has(tag), `<${tag}> has an optional end tag and must not be tracked`);
        });
    }

    it('still tracks elements that DO require a closing tag', () => {
        for (const tag of ['div', 'table', 'form', 'ul', 'select']) {
            assert.ok(STRUCTURAL_TAGS.has(tag), `<${tag}> requires a closing tag and must stay tracked`);
        }
    });
});

function doc(text: string): vscode.TextDocument {
    const lines = text.split('\n');
    return {
        getText: () => text,
        positionAt: (offset: number) => {
            let rem = offset;
            for (let i = 0; i < lines.length; i++) {
                if (rem <= lines[i].length) { return new vscode.Position(i, rem); }
                rem -= lines[i].length + 1;
            }
            return new vscode.Position(Math.max(0, lines.length - 1), 0);
        },
    } as unknown as vscode.TextDocument;
}
const messages = (text: string) => scanHtmlStructure(doc(text)).map(d => d.message);

// A `<` with no tag name after it is literal body text ("Total: 5 < 10"), not
// markup. Scanning it to the next `>` swallowed the real closing tag that
// followed and raised a false "Missing closing tag" — which also blocks Format
// Document, since formatting is refused while structure diagnostics exist.
describe('scanHtmlStructure — a bare < in body text', () => {
    it('does not report a missing </div> after a comparison in prose', () => {
        assert.deepStrictEqual(
            messages('<div class="report">\n  Total: 5 < 10 and rising\n</div>\n'),
            [],
        );
    });

    it('does not report anything when the < has no > of its own', () => {
        assert.deepStrictEqual(messages('<div>\n  qty < 5\n</div>\n'), []);
    });

    it('is unaffected when the comparison is escaped', () => {
        assert.deepStrictEqual(messages('<div>\n  a &lt; b\n</div>\n'), []);
    });

    it('still reports a genuinely unclosed tag', () => {
        const found = messages('<div class="outer">\n  <p>hello</p>\n');
        assert.strictEqual(found.length, 1);
        assert.ok(/no <\/div> found/.test(found[0]), `got ${JSON.stringify(found)}`);
    });

    it('still reports a stray closing tag', () => {
        const found = messages('<p>hi</p>\n</div>\n');
        assert.strictEqual(found.length, 1);
        assert.ok(/no opening <div>/.test(found[0]), `got ${JSON.stringify(found)}`);
    });

    it('still flags a closing tag on a void element', () => {
        const found = messages('<div>\n  <br></br>\n</div>\n');
        assert.strictEqual(found.length, 1);
        assert.ok(/void element/.test(found[0]), `got ${JSON.stringify(found)}`);
    });

    it('leaves a balanced document clean', () => {
        assert.deepStrictEqual(messages('<div>\n  <p>hi</p>\n</div>\n'), []);
    });
});

// Each branch of an If opening its own copy of a wrapper, or a tag whose
// partner Response.Write writes, is valid ASP; read top to bottom it looks
// unbalanced. Only one branch runs, so the branches are read as alternatives.
describe('scanHtmlStructure — tags VBScript decides', () => {
    it('accepts an If and an Else each opening the wrapper', () => {
        assert.deepStrictEqual(messages(
            '<% If isAdmin Then %>\n<div class="admin">\n<% Else %>\n<div class="user">\n<% End If %>\n  <p>content</p>\n</div>\n'), []);
    });

    it('accepts If / ElseIf / Else in multi-line blocks', () => {
        assert.deepStrictEqual(messages(
            '<%\nIf a = 1 Then\n%>\n<div class="one">\n<%\nElseIf a = 2 Then\n%>\n<div class="two">\n'
            + '<%\nElse\n%>\n<div class="three">\n<%\nEnd If\n%>\nbody\n</div>\n'), []);
    });

    it('accepts each Case of a Select Case opening the form', () => {
        assert.deepStrictEqual(messages(
            '<% Select Case mode %>\n<% Case 1 %><form action="a.asp">\n<% Case Else %><form action="b.asp">\n'
            + '<% End Select %>\n<input>\n</form>\n'), []);
    });

    it('accepts a closing tag in each branch', () => {
        assert.deepStrictEqual(messages('<div>\n<% If a Then %>\n</div>\n<% Else %>\n</div>\n<% End If %>\n'), []);
    });

    it('accepts an If inside a branch that opens nothing', () => {
        assert.deepStrictEqual(messages(
            '<% If a Then %>\n<div class="x">\n<% If b Then %><b>b</b><% End If %>\n<% Else %>\n'
            + '<div class="y">\n<% End If %>\n</div>\n'), []);
    });

    it('accepts a table Response.Write opens and the markup closes', () => {
        assert.deepStrictEqual(messages('<% Response.Write "<table class=""grid"">" %>\n<tr><td>x</td></tr>\n</table>\n'), []);
    });

    it('accepts a table the markup opens and Response.Write closes', () => {
        assert.deepStrictEqual(messages('<table>\n<tr><td>x</td></tr>\n<% Response.Write "</table>" %>\n'), []);
    });

    it('still reports a stray </table> when Response.Write writes a whole table', () => {
        const found = messages('<% Response.Write "<table><tr><td>x</td></tr></table>" %>\n<p>after</p>\n</table>\n');
        assert.strictEqual(found.length, 1, `got ${JSON.stringify(found)}`);
        assert.ok(/no opening <table>/.test(found[0]), `got ${JSON.stringify(found)}`);
    });

    it('still reports a branch that forgets its closing tag', () => {
        const found = messages('<% If a Then %>\n<div>a</div>\n<% Else %>\n<div>b\n<% End If %>\n');
        assert.strictEqual(found.length, 1, `got ${JSON.stringify(found)}`);
        assert.ok(/no <\/div> found/.test(found[0]), `got ${JSON.stringify(found)}`);
    });

    it('still reports a stray closing tag after the If', () => {
        const found = messages('<% If a Then %>\n<div>a</div>\n<% Else %>\n<div>b</div>\n<% End If %>\n</div>\n');
        assert.strictEqual(found.length, 1, `got ${JSON.stringify(found)}`);
        assert.ok(/no opening <div>/.test(found[0]), `got ${JSON.stringify(found)}`);
    });
});
