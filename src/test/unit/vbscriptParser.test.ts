import * as assert from 'assert';
import { tokenize, TokenKind } from '../../vbscript/lexer';
import { pagePrograms } from '../../vbscript/pageSegments';
import { parsePage, lineAt, symbolsFromTree } from '../../vbscript/symbols';

// Every "accepts" and "reports" case below was checked against cscript.exe,
// the VBScript engine IIS runs.

/** Wraps code in one `<% %>` block, so code line N is page line N (0-based line 0 is `<%`). */
const page = (code: string) => `<%\n${code}\n%>`;

/** "line: message" for every diagnostic, with lines counted from 1 inside the code. */
function diagnostics(text: string): string[] {
    const parsed = parsePage(text);
    return parsed.programs.flatMap(p => p.diagnostics.map(d => `${lineAt(parsed, d.start)}: ${d.message}`));
}

function tokenKinds(code: string): TokenKind[] {
    return tokenize(code, [{ kind: 'code', start: 0, end: code.length }]).tokens.map(t => t.kind);
}

describe('VBScript lexer', () => {
    it('reads "" inside a string as an escaped quote', () => {
        const code = 'x = "a""b"';
        const str = tokenize(code, [{ kind: 'code', start: 0, end: code.length }]).tokens.find(t => t.kind === TokenKind.String);
        assert.strictEqual(str?.value, '"a""b"');
        assert.strictEqual(str?.error, undefined);
    });

    it('reads Rem after a statement as a comment', () => {
        const { tokens, comments } = tokenize('x = 1 Rem note', [{ kind: 'code', start: 0, end: 14 }]);
        assert.ok(!tokens.some(t => t.value === 'rem' || t.value === 'note'));
        assert.strictEqual(comments.length, 1);
    });

    it('joins a line ending in _ with or without a space before it', () => {
        for (const code of ['x = 1 _\n+ 2', 'x = 1_\n+ 2', 'x = "a" &_\r\n"b"']) {
            assert.ok(!tokenKinds(code).slice(0, -2).includes(TokenKind.Newline), code);
        }
    });

    it('does not join a line when a comment follows the _', () => {
        assert.deepStrictEqual(diagnostics(page("x = 1 _ ' note\n+ 2")), ['1: Invalid character', '2: Expected statement']);
    });

    it('reads hex, octal, exponent and leading-dot numbers', () => {
        for (const n of ['&H1F', '&H1F&', '&O17', '1.5E-3', '.5', '1.', '1.e5']) {
            const kinds = tokenKinds(n);
            assert.deepStrictEqual(kinds, [TokenKind.Number, TokenKind.Newline, TokenKind.EOF], n);
        }
    });

    it('reads [any text] as one identifier', () => {
        const code = '[my var]';
        const t = tokenize(code, [{ kind: 'code', start: 0, end: code.length }]).tokens[0];
        assert.strictEqual(t.kind, TokenKind.Identifier);
        assert.strictEqual(t.value, 'my var');
    });
});

describe('VBScript parser — code VBScript accepts', () => {
    const accepted = [
        'Response.Write (a) & b',
        'f (a), b',
        'obj.M a, , c',
        'x = f(, 2)',
        'x.End = 1',
        'x = y. z',
        'x = [my var].y',
        'If x Then y = 1 Else z = 2',
        'If x Then: y = 1: End If',
        'If x Then\nElseIf y Then z = 1\nElse w = 2\nEnd If',
        'Select Case x : Case 1 : y = 1 : End Select',
        'x = a Is Nothing',
        'x = Not a = b',
        'x = -2 ^ 2 + 2 ^ -1',
        'x = 1 <= 2 >= 3 <> 4 =< 5',
        'Set x = New C',
        'Dim a(2, 3), b(), c(&H10)',
        'ReDim a(n + 1)',
        'Me.x = 1',
        'ReDim Preserve a(5)',
        'Dim step, property, default, error',
        'Const a = &H10, b = #1/1/2000#, c = True, d = -1, e = (1)',
        'Private Const a = 1',
        'Class C\nPrivate m\nPublic Default Function F\nEnd Function\nPublic Property Let P(v)\nEnd Property\nEnd Class',
        'With o\n.a = 1\n.b.c 2\nEnd With',
        'For i = 1 To 10 Step -1\nNext',
        'For i = 1 To 2\nNext\nFor i = 1 To 3\nNext',
        'Do : Loop While x',
        'On Error Resume Next\nOn Error GoTo 0',
        'Erase a, b',
        // A Sub may sit inside an If, though not inside a loop.
        'If x Then\nSub A\nEnd Sub\nEnd If',
    ];
    for (const code of accepted) {
        it(`accepts ${JSON.stringify(code)}`, () => {
            assert.deepStrictEqual(diagnostics(page(code)), []);
        });
    }
});

describe('VBScript parser — errors VBScript reports', () => {
    const rejected: [string, ...string[]][] = [
        ['f(1, 2)',                                       '1: Cannot use parentheses when calling a Sub'],
        ['Let x = 1',                                     '1: Expected statement'],
        ['Const a = 1 + 2',                               '1: Expected literal constant'],
        ['x = y .z',                                      '1: Expected end of statement'],
        ['x = New C()',                                   '1: Expected end of statement'],
        ['x = "abc',                                      '1: Unterminated string constant'],
        ['For Each i In c\nNext i',                       '2: Expected end of statement'],
        ['Do While x\nLoop While y',                      '2: Expected end of statement'],
        ['Exit For',                                      "1: Invalid 'exit' statement"],
        ['Sub A\nExit Function\nEnd Sub',                 "2: Expected 'Sub'"],
        ['For i = 1 To 2\nFor I = 1 To 3\nNext\nNext',    "2: Invalid 'for' loop control variable"],
        ['If x Then\ny = 1 : End If',                     '2: Must be first statement on the line'],
        ['Select Case x\ny = 1\nCase 1\nEnd Select',      "2: Expected 'Case'"],
        ['Dim a(n), b(-1), c(1.5)',                       '1: Expected integer constant'],
        ['Dim me',                                        '1: Expected identifier'],
        ['Class C\nConst a = 1\nEnd Class',               '2: Only declarations are allowed directly inside a Class'],
        ['Function F bar\nEnd Function',                  "1: Expected '('"],
        ['For i = 1 To 2\nSub A\nEnd Sub\nNext',          "2: Expected 'Next'", "4: Unexpected 'Next'"],
    ];
    for (const [code, ...expected] of rejected) {
        it(`reports ${JSON.stringify(code)}`, () => {
            assert.deepStrictEqual(diagnostics(page(code)), expected);
        });
    }
});

describe('VBScript parser — recovery', () => {
    it('lets an End Sub close the Sub around an unclosed If', () => {
        const code = 'Sub A\nIf x Then\ny = 1\nEnd Sub\nSub B\nEnd Sub';
        assert.deepStrictEqual(diagnostics(page(code)), ["4: Expected 'End If'"]);
        const fns = symbolsFromTree(page(code), 'x.asp').functions.map(f => [f.name, f.endLine]);
        assert.deepStrictEqual(fns, [['A', 4], ['B', 6]]);
    });

    it('starts a new Sub at a Sub line inside one that was never closed', () => {
        const code = 'Sub A\nx = 1\nSub B\nEnd Sub';
        assert.deepStrictEqual(diagnostics(page(code)), ["3: Expected 'End Sub'"]);
        const fns = symbolsFromTree(page(code), 'x.asp').functions.map(f => [f.name, f.endLine]);
        assert.deepStrictEqual(fns, [['A', -1], ['B', 4]]);
    });

    it('never throws on any prefix of a page, as it looks while being typed', () => {
        const text = page([
            'Option Explicit',
            'Dim rs, i : Set rs = Server.CreateObject("ADODB.Recordset")',
            'Class Cart',
            '  Private items',
            '  Public Property Get Count() : Count = UBound(items) + 1 : End Property',
            'End Class',
            'Function Total(ByVal a, ByRef b())',
            '  Select Case a',
            '    Case 1, 2 : Total = "x"" " & _',
            '      Mid(a, 1)',
            '    Case Else : If a Then Total = 0 Else Exit Function',
            '  End Select',
            'End Function',
            '%><p><%= Total(1, i) %></p><% For Each i In rs : Response.Write i : Next %>',
        ].join('\n'));
        for (let n = 0; n <= text.length; n++) {
            assert.doesNotThrow(() => symbolsFromTree(text.slice(0, n), 'x.asp'), `prefix of ${n} characters`);
        }
    });

    it('survives brackets nested thousands deep', () => {
        const code = 'x = ' + '('.repeat(5000) + '1' + ')'.repeat(5000);
        assert.ok(diagnostics(page(code)).length > 0);
    });
});

describe('VBScript page programs', () => {
    it('treats HTML between Select Case and the first Case as a statement, as IIS does', () => {
        const text = '<% Select Case x %>\n<p>hi</p>\n<% Case 1 %>\n<% End Select %>';
        assert.deepStrictEqual(diagnostics(text), ["1: Expected 'Case'"]);
    });

    it('does not treat whitespace between blocks as a statement', () => {
        assert.deepStrictEqual(diagnostics('<% Select Case x %>\n\n<% Case 1 %><% End Select %>'), []);
    });

    it('reads <% = x %> as output, as IIS does', () => {
        assert.deepStrictEqual(diagnostics('<p><% = title %></p>\n<%\n  = total\n%>'), []);
    });

    it('marks which script blocks run on the server', () => {
        const text = '<script language="vbscript" runat="server">\nx = 1\n</script><script language="vbscript">\ny = 2\n</script>';
        assert.deepStrictEqual(pagePrograms(text).map(p => p.server), [true, true, false]);
    });

    it('reads <%= %> as an expression, not an assignment', () => {
        const text = '<%= x = 1 %>';
        assert.deepStrictEqual(diagnostics(text), []);
        assert.deepStrictEqual(symbolsFromTree(text, 'x.asp').variables, []);
    });

    it('skips the directive, but not HTML, before Option Explicit', () => {
        assert.deepStrictEqual(diagnostics('<%@ Language="VBScript" %>\n<% Option Explicit %>'), []);
        assert.deepStrictEqual(diagnostics('<p>x</p>\n<% Option Explicit %>'),
            ['1: Option Explicit must be the first statement on the page']);
    });

    it('parses a <script language="vbscript"> body as a program of its own', () => {
        const text = '<% If x Then %><script language="vbscript">\nSub A\nEnd Sub\n</script><% End If %>';
        assert.strictEqual(pagePrograms(text).length, 2);
        assert.deepStrictEqual(diagnostics(text), []);
    });

    it('finds no VBScript in markup with no server code', () => {
        assert.deepStrictEqual(pagePrograms('<p>x = 1</p>'), []);
    });

    it('ends a block at the first %>, even inside a string', () => {
        assert.deepStrictEqual(diagnostics('<% x = "%>" %>'), ['0: Unterminated string constant']);
    });
});

describe('symbolsFromTree', () => {
    it('reads every kind of symbol from a typical page', () => {
        const text = [
            '<%@ Language="VBScript" %>',
            '<%',
            'Dim conn, total',
            'Const MAX_ROWS = 50, TITLE = "Orders, all"',
            'Set fso = Server.CreateObject("Scripting.FileSystemObject")',
            'Set f = fso.GetFile("x.txt")',
            'count = 0',
            'For Each item In list',
            'Next',
            'Function FormatRow(ByVal value, _',
            '                   label)',
            '    FormatRow = label & value',
            'End Function',
            'Class Account',
            '    Private mBalance',
            '    Public Property Get Balance()',
            '        Balance = mBalance',
            '    End Property',
            '    Public Sub Deposit(amt)',
            '    End Sub',
            'End Class',
            '%>',
            '<p><%= total %></p>',
        ].join('\n');
        const s = symbolsFromTree(text, 'x.asp');
        assert.deepStrictEqual(s.variables.map(v => [v.name, v.line, !!v.implicit]), [
            ['conn', 2, false], ['total', 2, false], ['count', 6, true], ['item', 7, true],
            ['FormatRow', 11, true], ['mBalance', 14, false], ['Balance', 16, true],
        ]);
        assert.deepStrictEqual(s.constants.map(c => [c.name, c.value, c.line]), [
            ['MAX_ROWS', '50', 3], ['TITLE', '"Orders, all"', 3],
        ]);
        assert.deepStrictEqual(s.functions.map(f => [f.kind, f.name, f.params, f.paramNames, f.line, f.endLine]), [
            ['Function', 'FormatRow', 'ByVal value, label', ['value', 'label'], 9, 12],
            ['Property', 'Balance', '', [], 15, 17],
            ['Sub', 'Deposit', 'amt', ['amt'], 18, 19],
        ]);
        assert.deepStrictEqual(s.comVariables.map(c => [c.name, c.progId, c.line]), [
            ['fso', 'scripting.filesystemobject', 4], ['f', 'scripting.file', 5],
        ]);
        assert.deepStrictEqual(s.classes.map(c => [c.name, c.line, c.endLine]), [['Account', 13, 20]]);
    });

    it('finds declarations the line scanner misses', () => {
        const text = page([
            'If ok Then y = 2',
            'x = 1 : Function Later(a)',
            'End Function',
        ].join('\n')) + '<% a = 1 %><% b = 2 %>';
        const s = symbolsFromTree(text, 'x.asp');
        assert.deepStrictEqual(s.variables.map(v => v.name), ['y', 'x', 'a', 'b']);
        assert.strictEqual(s.functions[0].endLine, 3);
    });
});
