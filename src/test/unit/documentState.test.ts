import * as assert from 'assert';
import * as vscode from 'vscode';
import { getZone } from '../../core/zoneUtils';
import { contextAt, textOf, zonesFor } from '../../platform/documentState';
import { fakeDocument } from './_helpers';

const PAGE = [
    '<html><head><style>p { color: red }</style>',      // 0
    '<script>var x = "<%= y %>";</script></head>',      // 1
    '<body><% Dim s : s = "a\'b" \' note %>',           // 2
    '<script language="vbscript">Sub A : End Sub</script>',
    '</body></html>',
].join('\n');

describe('documentState', () => {
    it('reads the text once per version, and again after an edit', () => {
        const document = fakeDocument(PAGE);
        textOf(document);
        zonesFor(document);
        contextAt(document, new vscode.Position(2, 10));
        assert.strictEqual(document.getTextCalls, 1);

        document.setText(PAGE + '\n<p>more</p>');
        assert.ok(textOf(document).endsWith('<p>more</p>'));
        assert.strictEqual(document.getTextCalls, 2);
    });

    it('answers every offset with the zone getZone gives', () => {
        const document = fakeDocument(PAGE);
        const zones = zonesFor(document);
        for (let offset = 0; offset <= PAGE.length; offset++) {
            assert.strictEqual(zones.zoneAt(offset), getZone(PAGE, offset), `offset ${offset}`);
        }
    });

    it('says whether the caret is in a VBScript string or comment, and only in VBScript', () => {
        const document = fakeDocument(PAGE);
        const at = (line: number, text: string) => contextAt(document, new vscode.Position(line, document.lineAt(line).text.indexOf(text)));
        assert.deepStrictEqual([at(2, 'Dim').zone, at(2, 'Dim').inVbStringOrComment], ['asp', false]);
        assert.strictEqual(at(2, "a'b").inVbStringOrComment, true);
        assert.strictEqual(at(2, 'note').inVbStringOrComment, true);
        assert.deepStrictEqual([at(1, 'var').zone, at(1, 'var').inVbStringOrComment], ['js', false]);
        assert.strictEqual(at(0, 'color').zone, 'css');
    });
});
