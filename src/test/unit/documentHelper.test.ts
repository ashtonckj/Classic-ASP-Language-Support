import * as assert from 'assert';
import { isInsideVbStringOrComment } from '../../utils/documentHelper';

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
