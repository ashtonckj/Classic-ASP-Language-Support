import * as assert from 'assert';
import {
    isInsideVbStringOrComment,
    indexOfWholeWord,
    aspCodeStartOnLine,
    isInsideVbString,
} from '../../utils/documentHelper';

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

// IntelliSense / go-to-definition must not fire where the token is
// data: inside a VBScript string literal or after a `'` comment.
describe('isInsideVbStringOrComment', () => {
    // helper: column right after the given marker substring
    const colAfter = (line: string, marker: string) => line.indexOf(marker) + marker.length;

    it('is true just after the dot inside "rs."', () => {
        const line = '    myText = "rs."';
        assert.strictEqual(isInsideVbStringOrComment(line, colAfter(line, '"rs.')), true);
    });

    it('is false in normal code before the string', () => {
        const line = '    myText = "rs."';
        assert.strictEqual(isInsideVbStringOrComment(line, colAfter(line, 'myText')), false);
    });

    it('is false again after a closed string', () => {
        const line = 'x = "abc" & y';
        assert.strictEqual(isInsideVbStringOrComment(line, colAfter(line, '& ')), false);
    });

    it('treats "" as an escaped quote (still inside the string)', () => {
        const line = 'x = "a ""b"" c.';
        assert.strictEqual(isInsideVbStringOrComment(line, colAfter(line, 'c.')), true);
    });

    it('is true after a apostrophe comment starts', () => {
        const line = "    ' Response.";
        assert.strictEqual(isInsideVbStringOrComment(line, colAfter(line, 'Response.')), true);
    });

    it('does not treat an apostrophe inside a string as a comment', () => {
        const line = 'msg = "it\'s here" ';
        assert.strictEqual(isInsideVbStringOrComment(line, line.length), false);
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

describe('isInsideVbString', () => {
    it('reports a string but not a comment', () => {
        assert.strictEqual(isInsideVbString("x = ' note", 10), false);
        assert.strictEqual(isInsideVbString('x = "abc', 8), true);
    });

    it('honours the start offset', () => {
        const line = '<p>"</p><% x = 1';
        // Scanning from 0 would see the stray quote in the HTML and report a string.
        assert.strictEqual(isInsideVbString(line, line.length, line.indexOf('<%') + 2), false);
    });
});
