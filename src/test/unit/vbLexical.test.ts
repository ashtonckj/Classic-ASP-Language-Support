import * as assert from 'assert';
import {
    codeWithoutStrings, endsWithContinuation, isInVbStringOrComment, scanVbLine, splitCodeAndComment,
    vbStatements, vbStringSegments,
} from '../../core/vbLexical';
import { tokenize, TokenKind } from '../../vbscript/lexer';

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

    // As the parser and the engine read them.
    it('takes off a Rem straight after a number, and keeps a member named Rem', () => {
        assert.deepStrictEqual(splitCodeAndComment('x = 5rem note'), { code: 'x = 5', comment: 'rem note' });
        assert.deepStrictEqual(splitCodeAndComment('x = a.Rem'), { code: 'x = a.Rem', comment: '' });
    });
});

describe('endsWithContinuation', () => {
    it('is true for a _ after a space or a closing quote or bracket', () => {
        assert.strictEqual(endsWithContinuation('sql = "SELECT" & _'), true);
        assert.strictEqual(endsWithContinuation('sql = "SELECT"_  '), true);
        assert.strictEqual(endsWithContinuation('x = (a)_'), true);
        assert.strictEqual(endsWithContinuation('_'), true);
        assert.strictEqual(endsWithContinuation('x = 1_'), true);
        assert.strictEqual(endsWithContinuation('x = y _'), true);
        assert.strictEqual(endsWithContinuation("<p>it's</p><% x = y _", 14), true);
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

    it('keeps the rest of a one-line If with the If', () => {
        assert.deepStrictEqual(vbStatements('x = 1 : If a Then b : c Else d'), ['x = 1 ', ' If a Then b : c Else d']);
        assert.deepStrictEqual(vbStatements('If a Then : b'), ['If a Then : b']);
        assert.deepStrictEqual(vbStatements('If a Then'), ['If a Then']);
    });

    it('does not split at a colon inside a bracketed name', () => {
        assert.deepStrictEqual(vbStatements('[a:b] = 1 : x = 2'), ['[a:b] = 1 ', ' x = 2']);
    });
});

// The line rules are the parser's lexer, so a line reads the same to both.
describe('scanVbLine agrees with the parser', () => {
    it('reads Rem after a dot and a space as a member, as cscript does', () => {
        assert.deepStrictEqual(splitCodeAndComment('x = a. Rem'), { code: 'x = a. Rem', comment: '' });
    });

    it('marks the same comment and strings as tokenize', () => {
        for (const line of ['x = "a\'b" \' c', 'If a Then Rem x', 'y = [it\'s] & "q""r"', 'z = #1/2/2000# & "s"_']) {
            const { tokens, comments } = tokenize(line, [{ kind: 'code', start: 0, end: line.length }]);
            const scan = scanVbLine(line);
            assert.strictEqual(scan.codeEnd, comments[0]?.start ?? line.length, line);
            assert.deepStrictEqual(scan.strings.map(s => s.start), tokens.filter(t => t.kind === TokenKind.String).map(t => t.start), line);
        }
    });
});
