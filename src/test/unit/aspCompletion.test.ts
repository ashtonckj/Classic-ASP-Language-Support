import * as assert from 'assert';
import { enclosingWithObject } from '../../providers/aspCompletionProvider';

// Inside `With rs … End With`, a statement can start with a bare `.` that means
// rs. Completion has to know which object that is to offer its members.
describe('enclosingWithObject', () => {
    /** The With object at the `|` in `page`. */
    function objectAt(page: string): string | undefined {
        const before = page.slice(0, page.indexOf('|'));
        const line   = before.split('\n').length - 1;
        const text   = page.replace('|', '');
        return enclosingWithObject(text, line, before.length - before.lastIndexOf('\n') - 1);
    }

    it('finds the object of the block the caret is in', () => {
        assert.strictEqual(objectAt('<%\nWith rs\n  .|\nEnd With\n%>'), 'rs');
    });

    it('keeps the object as written', () => {
        assert.strictEqual(
            objectAt('<%\nWith Server.CreateObject("Scripting.Dictionary")\n  .|\nEnd With\n%>'),
            'Server.CreateObject("Scripting.Dictionary")',
        );
    });

    it('finds the inner block of two nested ones, and the outer one after the inner ends', () => {
        const page = '<%\nWith rs\n  With conn\n    .|\n  End With\nEnd With\n%>';
        assert.strictEqual(objectAt(page), 'conn');
        assert.strictEqual(objectAt('<%\nWith rs\n  With conn\n  End With\n  .|\nEnd With\n%>'), 'rs');
    });

    it('is undefined outside a block, and after one has ended', () => {
        assert.strictEqual(objectAt('<%\nx = .|\n%>'), undefined);
        assert.strictEqual(objectAt('<%\nWith rs\nEnd With\n.|\n%>'), undefined);
    });

    it('does not reach into a block from another procedure', () => {
        const page = '<%\nWith rs\nSub Report()\n  .|\nEnd Sub\nEnd With\n%>';
        assert.strictEqual(objectAt(page), undefined);
    });

    it('reads blocks written in <% %> tags between markup', () => {
        assert.strictEqual(objectAt('<% With rs %>\n<p>With love</p>\n<td><%= .|'), 'rs');
        assert.strictEqual(objectAt('<% With rs : .|'), 'rs');
    });

    it('is not fooled by With in a comment, a string or markup', () => {
        assert.strictEqual(objectAt("<%\n' With rs\nx = \"With rs\"\n%>\n<p>With rs</p>\n<%\n.|\n%>"), undefined);
    });
});
