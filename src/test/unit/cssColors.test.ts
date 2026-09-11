import * as assert from 'assert';
import * as vscode from 'vscode';
import { CssColorProvider } from '../../providers/cssColorProvider';

// Colour swatches in an ASP page, in <style> blocks and in style="" attributes.
//
// The interesting part is not finding the colours — vscode-css-languageservice
// does that — but getting their positions right. A <style> block's virtual
// document is position-aligned, so its offsets are page offsets already; an
// inline style="" value is wrapped in a fake `* { … }` ruleset, so every offset
// in it is shifted by the wrapper. A mistake either way puts the swatch on the
// wrong characters, and the picker then overwrites the wrong text.

function fakeDoc(text: string): vscode.TextDocument {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') { lineStarts.push(i + 1); }
    }
    return {
        languageId: 'asp',
        version: 1,
        uri: { fsPath: 'C:\\site\\page.asp', scheme: 'file', toString: () => 'file:///page.asp' },
        getText: () => text,
        lineCount: lineStarts.length,
        lineAt: (n: number) => ({
            text: text.slice(lineStarts[n], lineStarts[n + 1] ?? text.length).replace(/\r?\n$/, ''),
        }),
        offsetAt: (p: { line: number; character: number }) => lineStarts[p.line] + p.character,
        positionAt: (offset: number) => {
            let lo = 0, hi = lineStarts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
            }
            return new vscode.Position(lo, offset - lineStarts[lo]);
        },
    } as unknown as vscode.TextDocument;
}

const provider      = new CssColorProvider();
const NOT_CANCELLED = { isCancellationRequested: false } as vscode.CancellationToken;

/** The colours found, each paired with the page text it covers. */
function coloursIn(text: string): Array<{ text: string; color: vscode.Color }> {
    const doc = fakeDoc(text);
    const out = provider.provideDocumentColors(doc, NOT_CANCELLED) as vscode.ColorInformation[];
    return (out ?? []).map(info => ({
        text:  text.slice(doc.offsetAt(info.range.start), doc.offsetAt(info.range.end)),
        color: info.color,
    }));
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe('Colour swatches inside a <style> block', () => {
    it('covers exactly the hex literal, not the property or the semicolon', () => {
        const found = coloursIn('<style>\n.a { color: #f9fbb7; }\n</style>\n');
        assert.deepStrictEqual(found.map(f => f.text), ['#f9fbb7']);
    });

    it('reads the hex value correctly', () => {
        const [red] = coloursIn('<style>\n.a { color: #ff0000; }\n</style>\n');
        assert.ok(close(red.color.red, 1) && close(red.color.green, 0) && close(red.color.blue, 0),
            `expected pure red; got ${JSON.stringify(red.color)}`);
    });

    it('finds rgb(), rgba(), hsl() and a named colour', () => {
        const found = coloursIn([
            '<style>',
            '.a { color: rgb(255, 0, 0); }',
            '.b { color: rgba(0, 0, 255, 0.5); }',
            '.c { color: hsl(120, 100%, 50%); }',
            '.d { color: red; }',
            '</style>',
            '',
        ].join('\n'));
        assert.deepStrictEqual(found.map(f => f.text), [
            'rgb(255, 0, 0)', 'rgba(0, 0, 255, 0.5)', 'hsl(120, 100%, 50%)', 'red',
        ]);
    });

    it('carries the alpha channel through', () => {
        const [half] = coloursIn('<style>\n.a { color: rgba(0, 0, 0, 0.5); }\n</style>\n');
        assert.ok(close(half.color.alpha, 0.5), `expected alpha 0.5; got ${half.color.alpha}`);
    });

    it('finds colours in every <style> block, not just the first', () => {
        const found = coloursIn([
            '<style>', '.a { color: #111111; }', '</style>',
            '<div>text</div>',
            '<style>', '.b { color: #222222; }', '</style>', '',
        ].join('\n'));
        assert.deepStrictEqual(found.map(f => f.text), ['#111111', '#222222']);
    });

    it('positions the swatch on the right line in a multi-line block', () => {
        const text = [
            '<html>', '<head>', '<style>',
            '  .a { margin: 0; }',
            '  .b { color: #abcdef; }',
            '</style>', '</head>', '</html>', '',
        ].join('\n');
        const doc = fakeDoc(text);
        const out = provider.provideDocumentColors(doc, NOT_CANCELLED) as vscode.ColorInformation[];
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].range.start.line, 4);
    });

    // stripAspExpressions blanks <%= %> before the CSS is parsed, so a value the
    // server writes at runtime is not a colour anyone can pick.
    it('does not treat an ASP expression as a colour', () => {
        const found = coloursIn('<style>\n.a { color: <%= themeColour %>; }\n</style>\n');
        assert.deepStrictEqual(found.map(f => f.text), []);
    });

    it('finds nothing in a page with no CSS', () => {
        assert.deepStrictEqual(coloursIn('<html>\n<body>red</body>\n</html>\n'), []);
    });
});

describe('Colour swatches inside a style="" attribute', () => {
    it('covers exactly the hex literal', () => {
        const found = coloursIn('<div style="color: #f9fbb7">x</div>\n');
        assert.deepStrictEqual(found.map(f => f.text), ['#f9fbb7']);
    });

    it('handles a single-quoted attribute', () => {
        const found = coloursIn("<div style='color: #123456'>x</div>\n");
        assert.deepStrictEqual(found.map(f => f.text), ['#123456']);
    });

    it('finds the second colour in a two-declaration value', () => {
        const found = coloursIn('<td style="color: #111111; background: #222222">x</td>\n');
        assert.deepStrictEqual(found.map(f => f.text), ['#111111', '#222222']);
    });

    it('handles several styled elements on one line', () => {
        const found = coloursIn('<i style="color:#aaaaaa"></i><b style="color:#bbbbbb"></b>\n');
        assert.deepStrictEqual(found.map(f => f.text), ['#aaaaaa', '#bbbbbb']);
    });

    it('positions the swatch correctly when the attribute is not on line 0', () => {
        const text = '<html>\n<body>\n<div style="color: #abcdef">x</div>\n</body>\n</html>\n';
        const doc  = fakeDoc(text);
        const out  = provider.provideDocumentColors(doc, NOT_CANCELLED) as vscode.ColorInformation[];
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].range.start.line, 2);
        assert.strictEqual(
            text.slice(doc.offsetAt(out[0].range.start), doc.offsetAt(out[0].range.end)),
            '#abcdef',
        );
    });
});

describe('The colour picker offers CSS notations', () => {
    it('offers a replacement that overwrites exactly the old colour', () => {
        const text = '<style>\n.a { color: #ff0000; }\n</style>\n';
        const doc  = fakeDoc(text);
        const start = text.indexOf('#ff0000');
        const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + 7));

        const out = provider.provideColorPresentations(
            new vscode.Color(0, 0, 1, 1), { document: doc, range }, NOT_CANCELLED,
        ) as vscode.ColorPresentation[];

        assert.ok(out && out.length, 'expected at least one presentation');
        const hex = out.find(p => p.label.startsWith('#'));
        assert.ok(hex, `expected a hex presentation; got ${JSON.stringify(out.map(p => p.label))}`);
        assert.strictEqual(hex.label.toLowerCase(), '#0000ff');
        assert.ok(hex.textEdit, 'the presentation must carry an edit');
        assert.deepStrictEqual(
            [hex.textEdit.range.start.line, hex.textEdit.range.start.character],
            [range.start.line, range.start.character],
            'the edit must replace the old colour, not sit beside it',
        );
    });

    it('offers a replacement for an inline style too', () => {
        const text  = '<div style="color: #ff0000">x</div>\n';
        const doc   = fakeDoc(text);
        const start = text.indexOf('#ff0000');
        const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + 7));

        const out = provider.provideColorPresentations(
            new vscode.Color(0, 1, 0, 1), { document: doc, range }, NOT_CANCELLED,
        ) as vscode.ColorPresentation[];

        const hex = (out ?? []).find(p => p.label.startsWith('#'));
        assert.ok(hex, `expected a hex presentation; got ${JSON.stringify((out ?? []).map(p => p.label))}`);
        assert.strictEqual(hex.label.toLowerCase(), '#00ff00');
    });
});
