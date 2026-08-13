import * as assert from 'assert';
import * as vscode from 'vscode';
import { AspDocumentSymbolProvider } from '../../providers/aspDocumentSymbolProvider';

// Minimal TextDocument for the outline provider: it reads getText, lineCount,
// lineAt(...).text and lineAt(...).range.end.
function doc(text: string): vscode.TextDocument {
    const lines = text.split('\n');
    return {
        languageId: 'asp',
        lineCount: lines.length,
        uri: { fsPath: 'x.asp' },
        getText: () => text,
        lineAt: (n: number) => ({
            text: lines[n],
            range: { end: new vscode.Position(n, lines[n].length) },
        }),
    } as unknown as vscode.TextDocument;
}

const outline = (text: string) =>
    new AspDocumentSymbolProvider().provideDocumentSymbols(doc(text)) as vscode.DocumentSymbol[];

const names = (list: vscode.DocumentSymbol[]) => list.map(s => s.name);
const find  = (list: vscode.DocumentSymbol[], name: string) => list.find(s => s.name === name)!;

const SOURCE = [
    '<%',                             // 0
    'Dim pageTitle',                  // 1
    'Const MAX = 10',                 // 2
    '',                               // 3
    'Class Cart',                     // 4
    '  Private items',                // 5
    '  Public Sub Add(sku)',          // 6
    '    items = sku',                // 7
    '  End Sub',                      // 8
    '  Public Property Get Count',    // 9
    '    Count = 1',                  // 10
    '  End Property',                 // 11
    'End Class',                      // 12
    '',                               // 13
    'Function Total(a)',              // 14
    '  Dim scratch',                  // 15
    '  Total = a',                    // 16
    'End Function',                   // 17
    '%>',                             // 18
].join('\n');

// A Class's range spans its whole body, so its members belong in that symbol's
// `children`. Emitting them as siblings produced overlapping ranges — which the
// DocumentSymbol contract forbids — and left the breadcrumb unable to show
// `Cart > Add`.
describe('AspDocumentSymbolProvider — class members are nested', () => {
    it('keeps only the file-level symbols at the top', () => {
        assert.deepStrictEqual(names(outline(SOURCE)).sort(), ['Cart', 'MAX', 'Total', 'pageTitle']);
    });

    it('nests the class members under the class', () => {
        const cart = find(outline(SOURCE), 'Cart');
        assert.deepStrictEqual(names(cart.children).sort(), ['Add', 'Count', 'items']);
    });

    it('leaves no sibling range overlapping another', () => {
        const top = outline(SOURCE);
        for (let i = 0; i < top.length; i++) {
            for (let j = i + 1; j < top.length; j++) {
                const a = top[i].range, b = top[j].range;
                const overlaps = a.start.line <= b.end.line && b.start.line <= a.end.line;
                assert.ok(!overlaps, `${top[i].name} and ${top[j].name} overlap`);
            }
        }
    });

    it('keeps every child inside its parent range', () => {
        const cart = find(outline(SOURCE), 'Cart');
        for (const child of cart.children) {
            assert.ok(
                child.range.start.line >= cart.range.start.line &&
                child.range.end.line   <= cart.range.end.line,
                `${child.name} falls outside Cart`,
            );
        }
    });

    it('sorts each level by line', () => {
        const cart = find(outline(SOURCE), 'Cart');
        const lines = cart.children.map(c => c.range.start.line);
        assert.deepStrictEqual(lines, [...lines].sort((a, b) => a - b));
    });
});

// The provider documented that it lists top-level Constants/Variables, but never
// emitted variables at all. In-body locals stay out: they belong to their routine,
// and without Option Explicit the implicit-assignment pass would otherwise fill
// the outline with every temporary the page assigns.
describe('AspDocumentSymbolProvider — variables', () => {
    it('lists a module-level Dim', () => {
        assert.ok(names(outline(SOURCE)).includes('pageTitle'));
    });

    it('marks it as a Variable', () => {
        assert.strictEqual(find(outline(SOURCE), 'pageTitle').kind, vscode.SymbolKind.Variable);
    });

    it('omits a variable declared inside a function body', () => {
        assert.ok(!names(outline(SOURCE)).includes('scratch'));
        const total = find(outline(SOURCE), 'Total');
        assert.deepStrictEqual(names(total.children), []);
    });

    it('does not list a COM variable twice', () => {
        const text = '<%\nDim conn\nSet conn = Server.CreateObject("ADODB.Connection")\n%>';
        assert.strictEqual(names(outline(text)).filter(n => n === 'conn').length, 1);
    });

    it('selects the name, not the whole line', () => {
        const title = find(outline(SOURCE), 'pageTitle');
        assert.strictEqual(title.selectionRange.start.character, 'Dim '.length);
        assert.strictEqual(title.selectionRange.end.character, 'Dim pageTitle'.length);
    });
});
