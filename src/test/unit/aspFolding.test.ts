import * as assert from 'assert';
import { indentationRanges } from '../../asp/aspFoldingProvider';

// A language with a folding provider loses VS Code's indentation folding, so
// the provider works it out the same way for the markup, scripts and styles.
describe('indentationRanges', () => {
    it('folds a line to the last line indented deeper below it, blank lines inside', () => {
        const lines = ['<div>', '    <p>a</p>', '', '    <p>b</p>', '</div>', '<script>', '\tif (a) {', '\t\tb();', '\t}', '</script>'];
        assert.deepStrictEqual(indentationRanges(lines, 4).sort((x, y) => x.start - y.start), [
            { start: 0, end: 3 }, { start: 5, end: 8 }, { start: 6, end: 7 },
        ]);
    });

    it('folds nothing on a flat page', () => {
        assert.deepStrictEqual(indentationRanges(['a', '', 'b'], 4), []);
    });
});
