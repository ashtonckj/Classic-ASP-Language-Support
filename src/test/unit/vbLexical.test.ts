import * as assert from 'assert';
import {
    codeWithoutStrings, endsWithContinuation, isInVbString, isInVbStringOrComment, splitCodeAndComment,
    vbStatements, vbStringSegments,
} from '../../core/vbLexical';

// The rules below are the parser's lexer's, which were checked against cscript.exe.

const colAfter = (line: string, marker: string) => line.indexOf(marker) + marker.length;

// IntelliSense / go-to-definition must not fire where the token is
// data: inside a VBScript string literal or after a `'` comment.
describe('isInVbStringOrComment', () => {
    it('is true just after the dot inside "rs."', () => {
        const line = '    myText = "rs."';
        assert.strictEqual(isInVbStringOrComment(line, colAfter(line, '"rs.')), true);
    });

    it('is false in normal code before the string', () => {
        const line = '    myText = "rs."';
        assert.strictEqual(isInVbStringOrComment(line, colAfter(line, 'myText')), false);
    });

    it('is false again after a closed string', () => {
        const line = 'x = "abc" & y';
        assert.strictEqual(isInVbStringOrComment(line, colAfter(line, '& ')), false);
    });

    it('treats "" as an escaped quote (still inside the string)', () => {
        const line = 'x = "a ""b"" c.';
        assert.strictEqual(isInVbStringOrComment(line, colAfter(line, 'c.')), true);
    });

    it("is true after a ' comment starts", () => {
        const line = "    ' Response.";
        assert.strictEqual(isInVbStringOrComment(line, colAfter(line, 'Response.')), true);
    });

    it('does not treat an apostrophe inside a string as a comment', () => {
        const line = 'msg = "it\'s here" ';
        assert.strictEqual(isInVbStringOrComment(line, line.length), false);
    });

    it('reads Rem as a comment anywhere outside a string, as the engine does', () => {
        const line = 'x = 1 Rem Response.';
        assert.strictEqual(isInVbStringOrComment(line, colAfter(line, 'Response.')), true);
        assert.strictEqual(isInVbStringOrComment('remaining = 1', 5), false);
        assert.strictEqual(isInVbStringOrComment('x = "Rem" & y', 13), false);
    });

    it("reads an apostrophe inside a [bracketed name] as part of the name", () => {
        assert.strictEqual(isInVbStringOrComment("[it's] = 1 + y", 14), false);
    });

    it('starts at the VBScript of a line that begins with HTML', () => {
        const line = "<td>it's</td><% total = 1";
        assert.strictEqual(isInVbStringOrComment(line, line.length), true);
        assert.strictEqual(isInVbStringOrComment(line, line.length, line.indexOf('<%') + 2), false);
    });
});

describe('isInVbString', () => {
    it('reports a string but not a comment', () => {
        assert.strictEqual(isInVbString("x = ' note", 10), false);
        assert.strictEqual(isInVbString('x = "abc', 8), true);
    });

    it('honours the start offset', () => {
        const line = '<p>"</p><% x = 1';
        // Scanning from 0 would see the stray quote in the HTML and report a string.
        assert.strictEqual(isInVbString(line, line.length, line.indexOf('<%') + 2), false);
    });
});

// A trailing comment must be taken off before opener matching, but an
// apostrophe inside a string is data, not a comment.
describe('splitCodeAndComment', () => {
    it('takes a trailing comment off so the opener can be matched', () => {
        assert.strictEqual(splitCodeAndComment("If b Then   ' note").code.trim(), 'If b Then');
        assert.strictEqual(splitCodeAndComment("If b Then   ' note").comment, "' note");
    });

    it('keeps an apostrophe that lives inside a string literal', () => {
        assert.strictEqual(splitCodeAndComment('x = "a \' b"').code, 'x = "a \' b"');
    });

    it('leaves a comment-free line unchanged', () => {
        assert.deepStrictEqual(splitCodeAndComment('For i = 1 To 10'), { code: 'For i = 1 To 10', comment: '' });
    });

    it('takes off a Rem comment, at the start of a line or after a statement', () => {
        assert.deepStrictEqual(splitCodeAndComment('Rem old code'), { code: '', comment: 'Rem old code' });
        assert.deepStrictEqual(splitCodeAndComment('x = 1 rem note'), { code: 'x = 1 ', comment: 'rem note' });
    });
});

describe('endsWithContinuation', () => {
    it('is true for a _ after a space or a closing quote or bracket', () => {
        assert.strictEqual(endsWithContinuation('sql = "SELECT" & _'), true);
        assert.strictEqual(endsWithContinuation('sql = "SELECT"_  '), true);
        assert.strictEqual(endsWithContinuation('x = (a)_'), true);
        assert.strictEqual(endsWithContinuation('_'), true);
    });

    it('is false for a name ending in _, a _ in a string, and a _ in a comment', () => {
        assert.strictEqual(endsWithContinuation('x = my_'), false);
        assert.strictEqual(endsWithContinuation('x = "a _'), false);
        assert.strictEqual(endsWithContinuation('x = "a _"'), false);
        assert.strictEqual(endsWithContinuation("x = 1 ' see below _"), false);
    });

    it('is false for a _ followed by a comment, which the engine rejects', () => {
        assert.strictEqual(endsWithContinuation("x = a & _ ' note"), false);
    });
});

describe('codeWithoutStrings', () => {
    it('leaves the code: no strings, no comment', () => {
        assert.strictEqual(codeWithoutStrings('If x = "End If" Then \' End If'), 'If x =  Then ');
    });
});

describe('vbStringSegments', () => {
    it('splits code into strings and the text between them, dropping nothing', () => {
        const parts = vbStringSegments('x = "a""b" & y & ""');
        assert.deepStrictEqual(parts, [
            { text: 'x = ', isString: false },
            { text: '"a""b"', isString: true },
            { text: ' & y & ', isString: false },
            { text: '""', isString: true },
        ]);
        assert.strictEqual(parts.map(p => p.text).join(''), 'x = "a""b" & y & ""');
    });
});

describe('vbStatements', () => {
    it('splits at colons outside strings and leaves the comment off', () => {
        assert.deepStrictEqual(vbStatements('For i = 1 To 3 : x = "a:b" : Next \' done: yes'), ['For i = 1 To 3 ', ' x = "a:b" ', ' Next ']);
    });
});
