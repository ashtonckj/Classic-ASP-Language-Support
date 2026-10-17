import * as assert from 'assert';
import * as vscode from 'vscode';
import { AspDocumentHighlightProvider } from '../../asp/aspRenameProvider';
import { fakeDocument } from './_helpers';

// Clicking a VBScript name highlights its other uses, as a .vb or .js file
// does; the JavaScript provider alone left VBScript with nothing at all.
describe('AspDocumentHighlightProvider', () => {
    const PAGE = '<%\nDim total\ntotal = 1\nSub Show()\n  Dim total\n  total = 2\nEnd Sub\nResponse.Write total\n%>\n<p>total</p>';
    const highlights = (n: number) => {
        const document = fakeDocument(PAGE, { fsPath: 'C:\\site\\page.asp' });
        let at = -1;
        for (let i = 0; i < n; i++) { at = PAGE.indexOf('total', at + 1); }
        return new AspDocumentHighlightProvider().provideDocumentHighlights(document as never, document.positionAt(at + 1) as never)
            ?.map(h => `${h.range.start.line}:${h.kind === vscode.DocumentHighlightKind.Write ? 'w' : 'r'}`);
    };

    it('marks the page variable where it is declared and read, not the local of the same name', () => {
        assert.deepStrictEqual(highlights(1), ['1:w', '2:r', '7:r']);
    });

    it('keeps a procedure local to its procedure', () => {
        assert.deepStrictEqual(highlights(3), ['4:w', '5:r']);
    });

    it('offers nothing in the markup', () => {
        assert.strictEqual(highlights(6), undefined);
    });
});
