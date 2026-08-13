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

// A `<` with no tag name after it is literal body text ("Total: 5 < 10"), not
// markup. Scanning it to the next `>` swallowed the real closing tag that
// followed and raised a false "Missing closing tag" — which also blocks Format
// Document, since formatting is refused while structure diagnostics exist.
describe('scanHtmlStructure — a bare < in body text', () => {
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
