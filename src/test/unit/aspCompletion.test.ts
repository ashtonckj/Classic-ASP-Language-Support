import * as assert from 'assert';
import { pageBlocks, withObjectAt, withObjectType } from '../../vbscript/pageAnalysis';
import { parsePage } from '../../vbscript/symbols';

// Inside `With rs … End With`, a statement can start with a bare `.` that means
// rs. Completion and hover have to know which object that is to offer its members.
describe('withObjectAt', () => {
    /** The With object at the `|` in `page`. */
    function objectAt(page: string) {
        const text = page.replace('|', '');
        return withObjectAt(pageBlocks(parsePage(text)).withBlocks, page.indexOf('|'));
    }

    it('finds the object of the block the caret is in', () => {
        assert.deepStrictEqual(objectAt('<%\nWith rs\n  .|\nEnd With\n%>'), { name: 'rs' });
    });

    it('reads an object created right there by its ProgID', () => {
        assert.deepStrictEqual(
            objectAt('<%\nWith Server.CreateObject("Scripting.Dictionary")\n  .|\nEnd With\n%>'),
            { progId: 'scripting.dictionary' },
        );
    });

    it('reads a method of a variable, with or without its arguments', () => {
        assert.deepStrictEqual(objectAt('<%\nWith conn.Execute(sql)\n  .|\nEnd With\n%>'), { name: 'conn', method: 'execute' });
        assert.deepStrictEqual(objectAt('<%\nWith rs.Fields\n  .|\nEnd With\n%>'), { name: 'rs', method: 'fields' });
        assert.strictEqual(objectAt('<%\nWith conn.Execute(sql)(0)\n  .|\nEnd With\n%>'), null);
    });

    it('finds the inner block of two nested ones, and the outer one after the inner ends', () => {
        const page = '<%\nWith rs\n  With conn\n    .|\n  End With\nEnd With\n%>';
        assert.deepStrictEqual(objectAt(page), { name: 'conn' });
        assert.deepStrictEqual(objectAt('<%\nWith rs\n  With conn\n  End With\n  .|\nEnd With\n%>'), { name: 'rs' });
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
        assert.deepStrictEqual(objectAt('<% With rs %>\n<p>With love</p>\n<td><%= .|'), { name: 'rs' });
        assert.deepStrictEqual(objectAt('<% With rs : .|'), { name: 'rs' });
    });

    it('finds a block still being typed, with no End With yet', () => {
        assert.deepStrictEqual(objectAt('<%\nSub Report()\n  With rs\n    .|\nEnd Sub\n%>'), { name: 'rs' });
        assert.deepStrictEqual(objectAt('<%\nWith rs\n  .|'), { name: 'rs' });
    });

    it('reads an object written over several lines as one', () => {
        assert.deepStrictEqual(
            objectAt('<%\nWith Server.CreateObject( _\n    "ADODB.Recordset")\n  .|\nEnd With\n%>'),
            { progId: 'adodb.recordset' },
        );
    });

    it('is not fooled by With in a comment, a string or markup', () => {
        assert.strictEqual(objectAt("<%\n' With rs\nx = \"With rs\"\n%>\n<p>With rs</p>\n<%\n.|\n%>"), undefined);
    });
});

// Hover and completion both take a With object's type from here, so they agree.
describe('withObjectType', () => {
    const com = new Map([['conn', 'adodb.connection'], ['rs', 'adodb.recordset']]);

    it('types an ASP object, a COM variable, a created object and a method result', () => {
        assert.strictEqual(withObjectType({ name: 'Response' }, com), 'response');
        assert.strictEqual(withObjectType({ name: 'RS' }, com), 'adodb.recordset');
        assert.strictEqual(withObjectType({ progId: 'scripting.dictionary' }, com), 'scripting.dictionary');
        assert.strictEqual(withObjectType({ name: 'conn', method: 'execute' }, com), 'adodb.recordset');
    });

    it('knows nothing of an unknown name or method', () => {
        assert.strictEqual(withObjectType({ name: 'thing' }, com), undefined);
        assert.strictEqual(withObjectType({ name: 'conn', method: 'nonesuch' }, com), undefined);
        assert.strictEqual(withObjectType(null, com), undefined);
    });
});
