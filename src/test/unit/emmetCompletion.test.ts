import * as assert from 'assert';
import { EmmetCompletionProvider } from '../../html/emmetCompletionProvider';
import { fakeDocument } from './_helpers';

// Emmet reads an abbreviation the way a .html file does: markup in markup, CSS
// in a <style> block and in a style="" value, nothing in VBScript.
describe('EmmetCompletionProvider', () => {
    const expansions = (text: string): string[] => {
        const at = text.indexOf('|');
        const document = fakeDocument(text.replace('|', ''));
        const list = new EmmetCompletionProvider().provideCompletionItems(document, document.positionAt(at));
        return (list?.items ?? []).map(item => String(item.label));
    };

    it('expands a CSS abbreviation inside a style attribute', () => {
        assert.deepStrictEqual(expansions('<p style="m10|">x</p>'), ['margin: 10px;']);
        assert.deepStrictEqual(expansions('<p style="color: red; p5|">x</p>'), ['padding: 5px;']);
    });

    it('expands the same abbreviation in a <style> block', () => {
        assert.deepStrictEqual(expansions('<style>\n.a { m10| }\n</style>'), ['margin: 10px;']);
    });

    it('offers nothing in VBScript', () => {
        assert.deepStrictEqual(expansions('<% Response.CharSet| %>'), []);
    });
});
