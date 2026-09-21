import * as assert from 'assert';
import { extractSymbols } from '../../utils/symbolParser';

// Class / Property Get/Let/Set are now extracted as symbols.
// Inline `<% Dim x %>` declarations are captured.
// Plus a guard so `Public Sub/Class/Property …` never leak in as bogus variables.

// A Dim line with an array bound must still register every declared name.
describe('extractSymbols — array declarations', () => {
    it('captures every name on a `Dim arr(10), total, count` line', () => {
        const s = extractSymbols('<%\nDim arr(10), total, count\n%>', 'x.asp');
        const names = s.variables.map(v => v.name);
        for (const n of ['arr', 'total', 'count']) {
            assert.ok(names.includes(n), `expected "${n}" in ${JSON.stringify(names)}`);
        }
    });

    it('handles ReDim Preserve buf(20)', () => {
        const s = extractSymbols('<%\nReDim Preserve buf(20)\n%>', 'x.asp');
        assert.ok(s.variables.map(v => v.name).includes('buf'));
    });

    it('still does not capture `Public Sub Foo` as a variable', () => {
        const s = extractSymbols('<%\nPublic Sub Foo\nEnd Sub\n%>', 'x.asp');
        assert.ok(!s.variables.some(v => /^(sub|foo)$/i.test(v.name)),
            `no bogus var from Public Sub; got ${JSON.stringify(s.variables.map(v => v.name))}`);
    });
});

describe('extractSymbols — Class / Property', () => {
    it('extracts a Class with its matching End Class line', () => {
        const text = [
            '<%',              // 0
            'Class Account',   // 1
            '  Private mBal',  // 2
            '  Public Sub Deposit(amt)', // 3
            '  End Sub',       // 4
            'End Class',       // 5
            '%>',              // 6
        ].join('\n');
        const s = extractSymbols(text, 'x.asp');
        const cls = s.classes.find(c => c.name === 'Account');
        assert.ok(cls, 'Account class should be extracted');
        assert.strictEqual(cls!.line, 1);
        assert.strictEqual(cls!.endLine, 5);
    });

    it('extracts Property Get and Property Let as callable symbols', () => {
        const text = [
            '<%',
            'Class Account',
            '  Public Property Get Balance',
            '  End Property',
            '  Public Property Let Balance(v)',
            '  End Property',
            'End Class',
            '%>',
        ].join('\n');
        const s = extractSymbols(text, 'x.asp');
        const props = s.functions.filter(f => f.name === 'Balance' && f.kind === 'Property');
        assert.strictEqual(props.length, 2, 'both Get and Let accessors');
        const letProp = props.find(p => p.paramNames.includes('v'));
        assert.ok(letProp, 'the Let accessor should record its value parameter');
    });

    it('pairs a nested Function endLine correctly inside a Class', () => {
        const text = [
            '<%',            // 0
            'Class C',       // 1
            '  Function F()', // 2
            '  End Function', // 3
            'End Class',     // 4
            '%>',            // 5
        ].join('\n');
        const s = extractSymbols(text, 'x.asp');
        assert.strictEqual(s.functions.find(f => f.name === 'F')!.endLine, 3);
        assert.strictEqual(s.classes.find(c => c.name === 'C')!.endLine, 4);
    });

    it('does NOT create bogus variables from Public Sub / Public Class', () => {
        const text = '<%\nPublic Sub Foo\nEnd Sub\nPublic Class Bar\nEnd Class\n%>';
        const s = extractSymbols(text, 'x.asp');
        assert.strictEqual(
            s.variables.length, 0,
            `expected no variables; got ${JSON.stringify(s.variables.map(v => v.name))}`,
        );
        assert.ok(s.functions.some(f => f.name === 'Foo' && f.kind === 'Sub'));
        assert.ok(s.classes.some(c => c.name === 'Bar'));
    });

    it('still captures a genuine Public variable', () => {
        const s = extractSymbols('<%\nPublic userName\n%>', 'x.asp');
        assert.ok(s.variables.some(v => v.name === 'userName'));
    });
});

describe('extractSymbols — ignores JS/CSS zones', () => {
    it('does not extract a JS function or var from a <script> block', () => {
        const text = [
            '<script>',
            'function foo() { return 1; }',
            'var y = 2;',
            '</script>',
            '<% Function Bar()',
            'End Function %>',
        ].join('\n');
        const s = extractSymbols(text, 'x.asp');
        assert.strictEqual(s.functions.some(f => f.name.toLowerCase() === 'foo'), false,
            `JS function must not leak; got ${JSON.stringify(s.functions.map(f => f.name))}`);
        assert.strictEqual(s.variables.some(v => v.name.toLowerCase() === 'y'), false,
            `JS var must not leak; got ${JSON.stringify(s.variables.map(v => v.name))}`);
        assert.ok(s.functions.some(f => f.name === 'Bar'), 'VBScript function should still be found');
    });

    it('still extracts symbols from a pure-code include (no <% %> wrappers)', () => {
        const text = 'Dim total\nFunction Helper()\nEnd Function';
        const s = extractSymbols(text, 'lib.inc');
        assert.ok(s.variables.some(v => v.name === 'total'), 'pure-code Dim should be kept');
        assert.ok(s.functions.some(f => f.name === 'Helper'), 'pure-code Function should be kept');
    });
});

describe('extractSymbols — inline declarations (A10)', () => {
    it('captures a variable from a one-line <% Dim x %> block', () => {
        const text = '<body>\n<% Dim total %>\n</body>';
        const s = extractSymbols(text, 'x.asp');
        assert.ok(
            s.variables.some(v => v.name === 'total'),
            `inline Dim should be captured; got ${JSON.stringify(s.variables.map(v => v.name))}`,
        );
    });

    it('captures multiple names from an inline Dim', () => {
        const s = extractSymbols('<% Dim a, b, c %>', 'x.asp');
        const names = s.variables.map(v => v.name);
        assert.deepStrictEqual(names.sort(), ['a', 'b', 'c']);
    });
});

// `Dim x : x = 1` is an everyday Classic ASP one-liner. Every declaration matcher
// is anchored at the start of a statement, so without splitting on `:` the whole
// line matched nothing and the variable disappeared from completion, hover,
// go-to-definition and rename.
describe('extractSymbols — colon-separated statements', () => {
    it('captures a Dim followed by an assignment on one line', () => {
        const s = extractSymbols('<%\nDim orderId : orderId = 42\n%>', 'x.asp');
        assert.deepStrictEqual(s.variables.map(v => v.name), ['orderId']);
    });

    it('captures names from two Dim statements on one line', () => {
        const s = extractSymbols('<%\nDim a, b : Dim c\n%>', 'x.asp');
        assert.deepStrictEqual(s.variables.map(v => v.name).sort(), ['a', 'b', 'c']);
    });

    it('captures a Dim followed by Set CreateObject', () => {
        const s = extractSymbols('<%\nDim conn : Set conn = Server.CreateObject("ADODB.Connection")\n%>', 'x.asp');
        assert.deepStrictEqual(s.variables.map(v => v.name), ['conn']);
        assert.deepStrictEqual(s.comVariables.map(c => c.progId), ['adodb.connection']);
    });

    it('captures two Const declarations on one line', () => {
        const s = extractSymbols('<%\nConst A = 1 : Const B = 2\n%>', 'x.asp');
        assert.deepStrictEqual(s.constants.map(c => `${c.name}=${c.value}`), ['A=1', 'B=2']);
    });

    it('does not split on a colon inside a string value', () => {
        const s = extractSymbols('<%\nConst URL = "http://example.com/a"\n%>', 'x.asp');
        assert.deepStrictEqual(s.constants.map(c => c.value), ['"http://example.com/a"']);
    });

    it('finds a Function declared after another statement', () => {
        const s = extractSymbols('<%\nx = 1 : Function Later(a)\nEnd Function\n%>', 'x.asp');
        assert.deepStrictEqual(s.functions.map(f => f.name), ['Later']);
    });
});

// A declaration split over a trailing `_` must be parsed whole, or its parameter
// list is lost and the continuation marker itself is captured as a variable.
describe('extractSymbols — line continuations', () => {
    it('keeps the parameter list of a continued Function header', () => {
        const s = extractSymbols('<%\nFunction Add( _\n    a, _\n    b)\n  Add = a + b\nEnd Function\n%>', 'x.asp');
        assert.deepStrictEqual(s.functions[0].paramNames, ['a', 'b']);
    });

    it('captures every name of a continued Dim', () => {
        const s = extractSymbols('<%\nDim total, _\n    count\n%>', 'x.asp');
        assert.deepStrictEqual(s.variables.map(v => v.name), ['total', 'count']);
    });

    it('never captures the continuation marker as a variable', () => {
        const s = extractSymbols('<%\nDim total, _\n    count\n%>', 'x.asp');
        assert.ok(!s.variables.some(v => v.name === '_'), 'a lone _ must never be a symbol');
    });

    it('reports the line the declaration starts on', () => {
        const s = extractSymbols('<%\nFunction Add( _\n    a)\nEnd Function\n%>', 'x.asp');
        assert.strictEqual(s.functions[0].line, 1);
    });

    it('still pairs a continued header with its End line', () => {
        const s = extractSymbols('<%\nFunction Add( _\n    a)\n  Add = a\nEnd Function\n%>', 'x.asp');
        assert.strictEqual(s.functions[0].endLine, 4);
    });

    it('does not treat a trailing _ inside a string as a continuation', () => {
        const s = extractSymbols('<%\nx = "ends with _"\nDim after\n%>', 'x.asp');
        assert.ok(s.variables.some(v => v.name === 'after'), 'the next line must still be parsed');
    });
});

// The CreateObject scan has to run on raw code (the ProgID lives in a string
// literal), so it needs its own comment stripping — otherwise a commented-out
// line registers a fully typed COM variable that offers member completions.
describe('extractSymbols — CreateObject in a comment', () => {
    it('ignores a commented-out CreateObject', () => {
        const s = extractSymbols('<%\nx = 1 \' Set oldConn = Server.CreateObject("ADODB.Connection")\n%>', 'x.asp');
        assert.deepStrictEqual(s.comVariables.map(c => c.name), []);
    });

    it('still captures a real CreateObject on a line that also has a comment', () => {
        const s = extractSymbols('<%\nSet rs = Server.CreateObject("ADODB.Recordset") \' the grid\n%>', 'x.asp');
        assert.deepStrictEqual(s.comVariables.map(c => c.name), ['rs']);
    });

    it('ignores an apostrophe in HTML sharing the line', () => {
        const s = extractSymbols('<td>it\'s</td><% Set rs = Server.CreateObject("ADODB.Recordset") %>', 'x.asp');
        assert.deepStrictEqual(s.comVariables.map(c => c.name), ['rs']);
    });
});

// The ProgID written inside CreateObject is what every consumer looks the COM
// type up by, so it has to come out of here in the form the type map is keyed
// on. It was taken raw apart from lowercasing, which left the spelling
// Microsoft's own documentation uses — version-pinned — resolving to nothing.
describe('extractSymbols — COM ProgIDs are normalised', () => {

    const progIdOf = (code: string) =>
        extractSymbols(`<%\n${code}\n%>`, 'x.asp').comVariables[0]?.progId;

    it('drops a pinned version', () => {
        assert.strictEqual(
            progIdOf('Set xml = Server.CreateObject("MSXML2.DOMDocument.6.0")'),
            'msxml2.domdocument',
        );
    });

    it('drops a single-digit version', () => {
        assert.strictEqual(
            progIdOf('Set conn = Server.CreateObject("ADODB.Connection.1")'),
            'adodb.connection',
        );
    });

    it('resolves an older alias to the type that replaced it', () => {
        assert.strictEqual(
            progIdOf('Set http = Server.CreateObject("Microsoft.XMLHTTP")'),
            'msxml2.serverxmlhttp',
        );
    });

    it('keeps a ProgID whose last component is not a version', () => {
        assert.strictEqual(
            progIdOf('Set d = Server.CreateObject("Scripting.Dictionary")'),
            'scripting.dictionary',
        );
    });

    it('leaves a third-party ProgID alone', () => {
        assert.strictEqual(
            progIdOf('Set up = Server.CreateObject("Persits.Upload")'),
            'persits.upload',
        );
    });

    it('carries the normalised type through a chained call', () => {
        const s = extractSymbols(
            '<%\nSet fso = Server.CreateObject("Scripting.FileSystemObject")\n'
            + 'Set ts = fso.OpenTextFile("c:\a.txt", 1)\n%>', 'x.asp');
        const ts = s.comVariables.find(c => c.name === 'ts');
        assert.ok(ts, 'ts should be inferred from the chained call');
        assert.strictEqual(ts.progId, 'scripting.textstream');
    });
});
