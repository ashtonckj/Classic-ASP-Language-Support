import * as assert from 'assert';
import * as vscode from 'vscode';
import { AspSemanticTokensProvider } from '../../providers/aspSemanticProvider';
import { COMBINED_SEMANTIC_LEGEND } from '../../providers/jsSemanticProvider';

// SQL colouring follows a variable: once `sql` is seen holding a SELECT, later
// fragments appended to it are coloured too. The passes that track which
// variables hold SQL match statements with patterns anchored at the start of the
// line, so they had to be fed the VBScript on the line rather than the raw text —
// a one-line `<% sql = … %>` block starts with `<%`, and a mixed HTML/ASP line
// starts with markup.

const TYPES = COMBINED_SEMANTIC_LEGEND.tokenTypes;

function fakeDoc(text: string): vscode.TextDocument {
    const lines = text.split('\n');
    const starts: number[] = [];
    let offset = 0;
    for (const l of lines) { starts.push(offset); offset += l.length + 1; }

    return {
        languageId: 'asp',
        version: 1,
        uri: { fsPath: 'C:\\site\\page.asp', scheme: 'file', toString: () => 'file:///page.asp' },
        getText: () => text,
        lineCount: lines.length,
        lineAt: (n: number) => ({ text: lines[n] }),
        offsetAt: (p: { line: number; character: number }) => starts[p.line] + p.character,
        positionAt: (off: number) => {
            let l = 0;
            while (l + 1 < starts.length && starts[l + 1] <= off) { l++; }
            return { line: l, character: off - starts[l] };
        },
    } as unknown as vscode.TextDocument;
}

const provider = new AspSemanticTokensProvider();

/** The SQL tokens the provider emits, as `type:"text"` strings. */
function sqlTokens(text: string): string[] {
    const result = provider.provideDocumentSemanticTokens(
        fakeDoc(text),
        { isCancellationRequested: false } as vscode.CancellationToken,
    ) as unknown as { tokens: { line: number; char: number; len: number; type: number }[] };

    const lines = text.split('\n');
    return (result?.tokens ?? [])
        .filter(t => String(TYPES[t.type]).startsWith('sql'))
        .map(t => `${TYPES[t.type]}:${lines[t.line].substr(t.char, t.len)}`);
}

const ASSIGN = 'sql = "SELECT name FROM users"';
const APPEND = 'sql = sql & " ORDER BY name DESC"';
const HTML   = '<td>Product listing for the currently selected category</td>';

// Everything appended to a SQL variable must be coloured, however the surrounding
// <% %> blocks happen to be laid out.
describe('SQL colouring follows a variable across block layouts', () => {
    const appendIsColoured = (text: string) =>
        sqlTokens(text).some(t => t === 'sqlDml:ORDER');

    it('colours an append inside the same multi-line block', () => {
        assert.ok(appendIsColoured(`<%\n${ASSIGN}\n${APPEND}\n%>\n`));
    });

    it('colours an append in a second multi-line block', () => {
        assert.ok(appendIsColoured(`<%\n${ASSIGN}\n%>\n<%\n${APPEND}\n%>\n`));
    });

    it('colours an append when both blocks are written on one line', () => {
        assert.ok(appendIsColoured(`<% ${ASSIGN} %>\n<% ${APPEND} %>\n`));
    });

    it('colours a one-line append after a multi-line assignment', () => {
        assert.ok(appendIsColoured(`<%\n${ASSIGN}\n%>\n<% ${APPEND} %>\n`));
    });

    it('colours a multi-line append after a one-line assignment', () => {
        assert.ok(appendIsColoured(`<% ${ASSIGN} %>\n<%\n${APPEND}\n%>\n`));
    });

    // A long HTML prefix used to push a mid-line zone probe out of the block.
    it('colours an append that shares its line with HTML', () => {
        assert.ok(appendIsColoured(`<%\n${ASSIGN}\n%>\n${HTML}<% ${APPEND} %>\n`));
    });

    it('colours an append when the assignment shares its line with HTML', () => {
        assert.ok(appendIsColoured(`${HTML}<% ${ASSIGN} %>\n<% ${APPEND} %>\n`));
    });

    it('colours an append inside a VBScript <script> block', () => {
        assert.ok(appendIsColoured(`<script language="vbscript">\n${ASSIGN}\n${APPEND}\n</script>\n`));
    });
});

describe('SQL colouring stays off things that are not SQL', () => {
    it('leaves an ordinary string alone', () => {
        assert.deepStrictEqual(sqlTokens('<%\nmsg = "Hello there, welcome back"\nmsg = msg & " again"\n%>\n'), []);
    });

    it('leaves a commented-out query alone', () => {
        assert.deepStrictEqual(sqlTokens('<%\n\' sql = "SELECT a FROM b"\nx = 1\n%>\n'), []);
    });

    it('leaves SQL-looking prose in the HTML alone', () => {
        assert.deepStrictEqual(sqlTokens('<p>SELECT name FROM users</p>\n<%\nx = 1\n%>\n'), []);
    });

    it('leaves a query inside a JavaScript block alone', () => {
        assert.deepStrictEqual(sqlTokens('<script>\n  var sql = "SELECT a FROM b";\n</script>\n'), []);
    });

    it('still colours a plain self-contained query', () => {
        const tokens = sqlTokens(`<%\n${ASSIGN}\n%>\n`);
        assert.ok(tokens.includes('sqlDml:SELECT'), `got ${JSON.stringify(tokens)}`);
        assert.ok(tokens.includes('sqlDml:FROM'), `got ${JSON.stringify(tokens)}`);
    });
});
