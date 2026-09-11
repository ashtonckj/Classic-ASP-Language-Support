import * as assert from 'assert';
import * as vscode from 'vscode';
import { JsDefinitionProvider } from '../../providers/jsDefinitionProvider';
import { JsReferenceProvider, JsDocumentHighlightProvider } from '../../providers/jsReferenceProvider';
import { JsRenameProvider } from '../../providers/jsRenameProvider';
import { disposeJsLanguageService } from '../../utils/jsUtils';

// F12, Shift+F12 and F2 inside a <script> block. A plain .html file gets these
// from the TypeScript server; a Classic ASP page has to ask, because its JS is
// spread over several <script> blocks and assembled into a virtual file with a
// generated preamble in front of it.
//
// The thing worth testing hardest is the preamble boundary. Every answer the
// language service gives is in virtual-file coordinates, and some of those
// answers point INTO the preamble or into lib.dom.d.ts. Offering one of those
// as a place to jump would send the reader to the wrong line; applying one as a
// rename edit would corrupt the page.

after(() => { disposeJsLanguageService(); });

function fakeDoc(text: string): vscode.TextDocument {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') { lineStarts.push(i + 1); }
    }
    const positionAt = (offset: number) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
        }
        return new vscode.Position(lo, offset - lineStarts[lo]);
    };
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
        positionAt,
    } as unknown as vscode.TextDocument;
}

const NOT_CANCELLED = { isCancellationRequested: false } as vscode.CancellationToken;

/** Offset of the Nth occurrence of `needle`, then `at` characters into it. */
function nth(text: string, needle: string, n: number, at = 0): number {
    let idx = -1;
    for (let i = 0; i < n; i++) { idx = text.indexOf(needle, idx + 1); }
    assert.ok(idx >= 0, `no occurrence ${n} of ${JSON.stringify(needle)}`);
    return idx + at;
}

const PAGE = [
    '<html>',
    '<body>',
    '<script>',
    'function addRow(label) {',
    '  var total = 0;',
    '  total = total + 1;',
    '  return label + total;',
    '}',
    '</script>',
    '<script>',
    'addRow("first");',
    '</script>',
    '</body>',
    '</html>',
    '',
].join('\n');

const definitionProvider = new JsDefinitionProvider();
const referenceProvider  = new JsReferenceProvider();
const highlightProvider  = new JsDocumentHighlightProvider();
const renameProvider     = new JsRenameProvider();

describe('Go to Definition inside a <script> block', () => {
    it('jumps from a call in one block to the declaration in another', () => {
        const doc = fakeDoc(PAGE);
        // The call in the SECOND <script> block.
        const at  = doc.positionAt(nth(PAGE, 'addRow', 2, 1));
        const out = definitionProvider.provideDefinition(doc, at, NOT_CANCELLED) as vscode.Location[];

        assert.ok(out && out.length, 'expected a definition');
        assert.strictEqual(out[0].range.start.line, 3, 'should land on the function declaration');
    });

    it('resolves a local variable to its own declaration', () => {
        const doc = fakeDoc(PAGE);
        const at  = doc.positionAt(nth(PAGE, 'total', 3, 1));
        const out = definitionProvider.provideDefinition(doc, at, NOT_CANCELLED) as vscode.Location[];

        assert.ok(out && out.length, 'expected a definition');
        assert.strictEqual(out[0].range.start.line, 4, 'should land on the var declaration');
    });

    it('offers nothing for a DOM member, whose definition is not in the page', () => {
        const text = '<script>\ndocument.getElementById("x");\n</script>\n';
        const doc  = fakeDoc(text);
        const at   = doc.positionAt(text.indexOf('getElementById') + 2);
        const out  = definitionProvider.provideDefinition(doc, at, NOT_CANCELLED);

        assert.strictEqual(out, undefined, 'lib.dom.d.ts is not a place in this document');
    });

    it('declines a position outside a <script> block', () => {
        const doc = fakeDoc(PAGE);
        const at  = doc.positionAt(PAGE.indexOf('<body>') + 2);
        assert.strictEqual(definitionProvider.provideDefinition(doc, at, NOT_CANCELLED), undefined);
    });
});

describe('Find All References inside a <script> block', () => {
    const withDeclaration    = { includeDeclaration: true }  as vscode.ReferenceContext;
    const withoutDeclaration = { includeDeclaration: false } as vscode.ReferenceContext;

    it('finds every use of a local across the function', () => {
        const doc = fakeDoc(PAGE);
        const at  = doc.positionAt(nth(PAGE, 'total', 1, 1));
        const out = referenceProvider.provideReferences(
            doc, at, withDeclaration, NOT_CANCELLED,
        ) as vscode.Location[];

        // var total / total = / total + 1 / return … total
        assert.strictEqual(out.length, 4, `got ${JSON.stringify(out.map(l => l.range.start.line))}`);
    });

    it('finds a function used from another <script> block', () => {
        const doc = fakeDoc(PAGE);
        const at  = doc.positionAt(nth(PAGE, 'addRow', 1, 1));
        const out = referenceProvider.provideReferences(
            doc, at, withDeclaration, NOT_CANCELLED,
        ) as vscode.Location[];

        const lines = out.map(l => l.range.start.line).sort((a, b) => a - b);
        assert.deepStrictEqual(lines, [3, 10], 'declaration and the cross-block call');
    });

    it('drops the declaration when the caller does not want it', () => {
        const doc = fakeDoc(PAGE);
        const at  = doc.positionAt(nth(PAGE, 'addRow', 1, 1));
        const out = referenceProvider.provideReferences(
            doc, at, withoutDeclaration, NOT_CANCELLED,
        ) as vscode.Location[];

        assert.deepStrictEqual(out.map(l => l.range.start.line), [10]);
    });
});

describe('Occurrence highlighting inside a <script> block', () => {
    it('separates the write from the reads', () => {
        const doc = fakeDoc(PAGE);
        const at  = doc.positionAt(nth(PAGE, 'total', 1, 1));
        const out = highlightProvider.provideDocumentHighlights(
            doc, at, NOT_CANCELLED,
        ) as vscode.DocumentHighlight[];

        assert.ok(out && out.length >= 4, `expected every occurrence; got ${out && out.length}`);
        assert.ok(
            out.some(h => h.kind === vscode.DocumentHighlightKind.Write),
            'the assignment should be a write',
        );
    });

    // The whole point over VS Code's textual fallback: a word inside a string is
    // not a use of the variable.
    it('does not highlight the same word inside a string', () => {
        const text = '<script>\nvar total = 0;\nalert("total");\n</script>\n';
        const doc  = fakeDoc(text);
        const at   = doc.positionAt(text.indexOf('total') + 1);
        const out  = highlightProvider.provideDocumentHighlights(
            doc, at, NOT_CANCELLED,
        ) as vscode.DocumentHighlight[];

        const lines = (out ?? []).map(h => h.range.start.line);
        assert.ok(!lines.includes(2), `the string on line 2 is not a use; got ${JSON.stringify(lines)}`);
    });
});

describe('Rename inside a <script> block', () => {
    it('renames every use of a local', () => {
        const doc  = fakeDoc(PAGE);
        const at   = doc.positionAt(nth(PAGE, 'total', 1, 1));
        const edit = renameProvider.provideRenameEdits(
            doc, at, 'runningTotal', NOT_CANCELLED,
        ) as vscode.WorkspaceEdit;

        assert.ok(edit, 'expected edits');
        assert.strictEqual(edit.size, 1, 'one file — a page is the whole scope for client-side JS');
    });

    it('renames a function across <script> blocks', () => {
        const doc  = fakeDoc(PAGE);
        const at   = doc.positionAt(nth(PAGE, 'addRow', 1, 1));
        const edit = renameProvider.provideRenameEdits(
            doc, at, 'appendRow', NOT_CANCELLED,
        ) as vscode.WorkspaceEdit;

        const edits = edit.get(doc.uri);
        assert.deepStrictEqual(
            edits.map(e => e.range.start.line).sort((a, b) => a - b), [3, 10],
        );
    });

    it('refuses a DOM member rather than renaming a call it cannot fix', () => {
        const text = '<script>\ndocument.getElementById("x");\n</script>\n';
        const doc  = fakeDoc(text);
        const at   = doc.positionAt(text.indexOf('getElementById') + 2);
        assert.throws(
            () => renameProvider.prepareRename(doc, at, NOT_CANCELLED),
            /cannot rename|cannot be renamed|not part of the page/i,
        );
    });

    it('opens on the symbol itself for a name it can rename', () => {
        const doc   = fakeDoc(PAGE);
        const at    = doc.positionAt(nth(PAGE, 'total', 1, 1));
        const range = renameProvider.prepareRename(doc, at, NOT_CANCELLED) as vscode.Range;

        assert.strictEqual(range.start.line, 4);
        assert.strictEqual(
            PAGE.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)), 'total',
        );
    });

    it('declines a position outside a <script> block, leaving VBScript to the ASP provider', () => {
        const doc = fakeDoc(PAGE);
        const at  = doc.positionAt(PAGE.indexOf('<body>') + 2);
        assert.strictEqual(renameProvider.prepareRename(doc, at, NOT_CANCELLED), undefined);
        assert.strictEqual(
            renameProvider.provideRenameEdits(doc, at, 'x', NOT_CANCELLED), undefined,
        );
    });
});
