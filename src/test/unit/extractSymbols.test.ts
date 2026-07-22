import * as assert from 'assert';
import { extractSymbols } from '../../providers/includeProvider';

// A2 — Class / Property Get/Let/Set are now extracted as symbols.
// A10 — inline `<% Dim x %>` declarations are captured.
// Plus a guard so `Public Sub/Class/Property …` never leak in as bogus variables.

describe('extractSymbols — Class / Property (A2)', () => {
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

describe('extractSymbols — ignores JS/CSS zones (A5)', () => {
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
