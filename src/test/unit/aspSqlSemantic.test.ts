import * as assert from 'assert';
import * as vscode from 'vscode';
import { AspSemanticTokensProvider } from '../../providers/aspSemanticProvider';
import { colourAspPage } from '../../utils/aspColouring';
import { colourAspPage as colourOnWorker, disposeAnalysisWorkers } from '../../utils/analysisClient';
import { COMBINED_SEMANTIC_LEGEND } from '../../providers/jsSemanticProvider';
import type { FileSymbols } from '../../utils/symbolParser';

// SQL colouring follows a variable: once `sql` is seen holding a SELECT, later
// fragments appended to it are coloured too. The passes that track which
// variables hold SQL match statements with patterns anchored at the start of the
// line, so they had to be fed the VBScript on the line rather than the raw text —
// a one-line `<% sql = … %>` block starts with `<%`, and a mixed HTML/ASP line
// starts with markup.

const TYPES = COMBINED_SEMANTIC_LEGEND.tokenTypes;

const EMPTY_INCLUDES = { variables: [], constants: [], functions: [], comVariables: [], classes: [] };

const PAGE_PATH = 'C:\\site\\page.asp';

/** The page's tokens as [line, char, length, type, modifiers], straight from the colouring. */
function tokensOf(text: string): number[][] {
    const { tokens } = colourAspPage({ id: 1, text, docPath: PAGE_PATH, includeSymbols: EMPTY_INCLUDES });
    const out: number[][] = [];
    for (let i = 0; i + 4 < tokens.length; i += 5) { out.push(Array.from(tokens.subarray(i, i + 5))); }
    return out;
}

/** The SQL tokens the colouring emits, as `type:"text"` strings. */
function sqlTokens(text: string): string[] {
    const lines = text.split('\n');
    return tokensOf(text)
        .filter(([, , , type]) => String(TYPES[type]).startsWith('sql'))
        .map(([line, char, len, type]) => `${TYPES[type]}:${lines[line].substr(char, len)}`);
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

// A query handed to a method is not the value assigned: `n` below holds a
// count, so `conn` next to it is not being concatenated into SQL.
describe('SQL warnings on a query passed to a method', () => {
    const warningsOf = (text: string) =>
        colourAspPage({ id: 1, text, docPath: PAGE_PATH, includeSymbols: EMPTY_INCLUDES }).warnings.map(w => w.message);
    const CONN = 'Set conn = Server.CreateObject("ADODB.Connection")';

    it('says nothing about what a method returns', () => {
        assert.deepStrictEqual(warningsOf(`<%\n${CONN}\nn = conn.Execute("SELECT COUNT(*) FROM Orders")(0)\n%>\n`), []);
        assert.deepStrictEqual(warningsOf(`<%\n${CONN}\nrs = conn.Execute("SELECT * FROM Orders")\n%>\n`), []);
    });

    it('still colours the query', () => {
        const tokens = sqlTokens(`<%\n${CONN}\nn = conn.Execute("SELECT COUNT(*) FROM Orders")(0)\n%>\n`);
        assert.ok(tokens.includes('sqlDml:SELECT') && tokens.includes('sqlDml:FROM'), `got ${JSON.stringify(tokens)}`);
    });

    it('still treats a query changed by Replace as SQL', () => {
        const page = `<%\nDim id, sql\nsql = Replace("SELECT a FROM b WHERE id = {0}", "{0}", id)\nsql = sql & id\n%>\n`;
        assert.ok(warningsOf(page).some(m => m.includes("'id' is concatenated into SQL variable 'sql'")), JSON.stringify(warningsOf(page)));
    });
});

// The colouring runs on a worker thread; on the extension host it held up
// typing and every other feature for a few hundred ms per edit on a large page.
describe('ASP colouring on the worker thread', () => {
    const PAGE = [
        '<%',
        'Dim total, sql',
        'Const LIMIT = 10',
        'Function Fetch(id)',
        '  sql = "SELECT name FROM users WHERE id = " & id',
        '  sql = sql & " ORDER BY name"',
        '  Fetch = sql',
        'End Function',
        '%>',
        '<p><%= Fetch(total) %> of <%= LIMIT %></p>',
        '',
    ].join('\n');

    function fakeDoc(text: string): vscode.TextDocument {
        return {
            languageId: 'asp',
            version: 1,
            uri: { fsPath: PAGE_PATH, scheme: 'file', toString: () => 'file:///page.asp' },
            getText: () => text,
        } as unknown as vscode.TextDocument;
    }

    after(() => { disposeAnalysisWorkers(); });

    it('gives the editor the tokens the colouring works out', async function () {
        this.timeout(30000);

        const provider = new AspSemanticTokensProvider();
        const result = await provider.provideDocumentSemanticTokens(
            fakeDoc(PAGE), { isCancellationRequested: false } as vscode.CancellationToken,
        ) as unknown as { tokens: { line: number; char: number; len: number; type: number; mod: number }[] };

        const fromEditor = result.tokens.map(t => [t.line, t.char, t.len, t.type, t.mod]);
        assert.ok(fromEditor.length > 10, 'the page should have been coloured');
        assert.deepStrictEqual(fromEditor, tokensOf(PAGE));
    });

    it('answers unchanged text and includes again without colouring it again', async function () {
        this.timeout(30000);

        const includes: FileSymbols = { variables: [], constants: [], functions: [], comVariables: [], classes: [] };
        const first  = await colourOnWorker('again.asp', PAGE, PAGE_PATH, includes);
        const second = await colourOnWorker('again.asp', PAGE, PAGE_PATH, includes);
        assert.ok(first);
        assert.strictEqual(second, first);

        // New include symbols can change the colours even when the page has not.
        const fromInclude: FileSymbols = { ...includes, functions: [{ name: 'total', kind: 'Function', params: '', paramNames: [], line: 0, endLine: 2, filePath: 'C:\\site\\lib.inc' }] };
        const third = await colourOnWorker('again.asp', PAGE, PAGE_PATH, fromInclude);
        assert.ok(third);
        assert.notStrictEqual(third, first);
    });

    it('colours a CRLF page the same as an LF one', () => {
        assert.deepStrictEqual(tokensOf(PAGE.replace(/\n/g, '\r\n')), tokensOf(PAGE));
    });
});
