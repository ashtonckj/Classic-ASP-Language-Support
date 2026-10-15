import * as assert from 'assert';
import { indexOfWholeWord, aspCodeStartOnLine } from '../../platform/documentHelper';

describe('indexOfWholeWord', () => {
    it('finds the standalone word, not a substring in a longer identifier', () => {
        assert.strictEqual(indexOfWholeWord('Dim accountCount, count', 'count'), 18);
    });
    it('is case-insensitive', () => {
        assert.strictEqual(indexOfWholeWord('Dim Total', 'total'), 4);
    });
    it('returns -1 when the whole word is absent', () => {
        assert.strictEqual(indexOfWholeWord('Dim accountCounter', 'count'), -1);
    });
});

// A physical line can mix HTML and VBScript. Any line-local scan for strings or
// `'` comments has to begin at the script, or an apostrophe in the HTML part
// ("it's", class='box') reads as a comment marker and silently switches off
// completion, go-to-definition, hover and rename for the rest of the line.
describe('aspCodeStartOnLine', () => {
    it('returns 0 for a line with no <% (inside a multi-line block)', () => {
        assert.strictEqual(aspCodeStartOnLine('  total = total + 1', 19), 0);
    });

    it('starts after the <% of an inline block', () => {
        const line = "<td>it's here</td><% total = 1 %>";
        assert.strictEqual(aspCodeStartOnLine(line, line.indexOf('total')), line.indexOf('<%') + 2);
    });

    it('skips the marker of an output expression', () => {
        const line = '<td><%= total %></td>';
        assert.strictEqual(aspCodeStartOnLine(line, line.indexOf('total')), line.indexOf('<%=') + 3);
    });

    it('tracks the second block when a line has two', () => {
        const line = '<% a = 1 %> plain <% b = 2 %>';
        assert.strictEqual(aspCodeStartOnLine(line, line.indexOf('b =')), line.lastIndexOf('<%') + 2);
    });

    it('never returns past the column asked about', () => {
        const line = '<% x = 1 %>';
        assert.strictEqual(aspCodeStartOnLine(line, 1), 1);
    });
});
