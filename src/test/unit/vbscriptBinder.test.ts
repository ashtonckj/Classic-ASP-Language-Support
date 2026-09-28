import * as assert from 'assert';
import * as path from 'path';
import { bindPage, bindScriptScope, type Binding } from '../../vbscript/binder';
import { buildScriptScope, type ScopeHost } from '../../vbscript/scriptScope';
import { lineAt, parsePage } from '../../vbscript/symbols';
import { resolveIncludeDirective } from '../../utils/includeDirectives';

// The "Name redefined" cases below were checked against cscript.exe.

const page = (code: string) => `<%\n${code}\n%>`;

function bindCode(code: string): { binding: Binding; lineOf: (offset: number) => number } {
    const parsed = parsePage(page(code));
    return { binding: bindPage('page.asp', parsed), lineOf: o => lineAt(parsed, o) };
}

/** Lines, counted from 1 inside the code, that are reported as a name declared twice. */
function redefinedLines(code: string): number[] {
    const { binding, lineOf } = bindCode(code);
    return binding.diagnostics.filter(d => d.message === 'Name redefined').map(d => lineOf(d.start));
}

/** What the use of `name` on code line `line` refers to: "kind scope@line", or null. */
function resolved(code: string, name: string, line: number): string | null {
    const { binding, lineOf } = bindCode(code);
    const ref = binding.references.find(r => !r.declaration && r.name === name && lineOf(r.span.start) === line);
    assert.ok(ref, `no use of ${name} on line ${line}`);
    const t = ref!.target;
    return t ? `${t.kind}${t.implicit ? ' (implicit)' : ''} ${t.scope.kind}@${lineOf(t.span.start)}` : null;
}

/** A host over an in-memory site, with the site root as the virtual root. */
function site(files: Record<string, string>): ScopeHost & { reads: string[] } {
    const root = path.resolve('/site');
    const reads: string[] = [];
    return {
        reads,
        read: p => {
            reads.push(p);
            const rel = path.relative(root, p).replace(/\\/g, '/');
            return rel in files ? files[rel] : null;
        },
        resolve: (d, from) => resolveIncludeDirective(d, from, root),
    };
}

const at = (p: string) => path.resolve('/site', p);

describe('binder — what a name refers to', () => {
    const code = [
        'Dim total, i',                          // 1
        'Sub Add(n)',                            // 2
        '  total = total + n',                   // 3
        '  Dim i',                               // 4
        '  i = 2',                               // 5
        '  temp = 3',                            // 6
        'End Sub',                               // 7
        'Function Twice(x)',                     // 8
        '  Twice = x * 2',                       // 9
        'End Function',                          // 10
        'Class Cart',                            // 11
        '  Private items',                       // 12
        '  Public Sub Put(v) : items = v : Me.Count = 1 : End Sub',   // 13
        '  Public Property Get Count() : Count = items : End Property', // 14
        'End Class',                             // 15
        'For i = 1 To 2 : Add i : Next',         // 16
        'Response.Write Twice(total)',           // 17
    ].join('\n');

    it('finds the page variable from inside a Sub that does not declare it', () => {
        assert.strictEqual(resolved(code, 'total', 3), 'variable script@1');
    });

    it('finds a local Dim before the page variable of the same name', () => {
        assert.strictEqual(resolved(code, 'i', 5), 'variable procedure@4');
        assert.strictEqual(resolved(code, 'i', 16), 'variable script@1');
    });

    it('makes a name only assigned inside a Sub a local of that Sub', () => {
        const { binding, lineOf } = bindCode(code);
        const temp = binding.declarations.find(d => d.name === 'temp')!;
        assert.strictEqual(`${temp.scope.kind}@${lineOf(temp.span.start)} ${temp.implicit}`, 'procedure@6 true');
    });

    it("reads a Function's own name inside it as the Function", () => {
        assert.strictEqual(resolved(code, 'twice', 9), 'function script@8');
    });

    it('finds class members from inside the class, and through Me', () => {
        assert.strictEqual(resolved(code, 'items', 13), 'variable class@12');
        assert.strictEqual(resolved(code, 'count', 13), 'property class@14');
    });

    it('leaves built-in names unresolved', () => {
        assert.strictEqual(resolved(code, 'response', 17), null);
    });

    it('declares nothing implicitly under Option Explicit', () => {
        const { binding } = bindCode('Option Explicit\nSub S\n  x = 1\nEnd Sub\ny = 2');
        assert.deepStrictEqual(binding.declarations.filter(d => d.implicit), []);
        assert.ok(binding.references.some(r => r.name === 'x' && r.target === null));
    });

    it('finds a page variable an include declares', () => {
        const host = site({ 'lib.inc': '<%\nDim shared\nSub Bump\n  shared = shared + 1\nEnd Sub\n%>' });
        const scope = buildScriptScope(at('page.asp'), '<!-- #include file="lib.inc" -->\n<% shared = 0 : Bump %>', host);
        const binding = bindScriptScope(scope);
        const uses = binding.references.filter(r => r.name === 'shared' && !r.declaration);
        assert.strictEqual(uses.length, 3);
        assert.ok(uses.every(r => r.target?.file === at('lib.inc') && !r.target.implicit));
    });

    it('records a member of an object, with or without the object, but not through Me', () => {
        const { binding, lineOf } = bindCode('cart.Put 1\nWith cart\n  x = .Count\nEnd With\nx = Me.Total');
        assert.deepStrictEqual(binding.members.map(m => `${m.name}@${lineOf(m.span.start)}`), ['put@1', 'count@3']);
        assert.ok(!binding.references.some(r => r.name === 'put' || r.name === 'count'));
    });

    it('still looks up a name in the part of a line skipped after an error', () => {
        const code = 'Dim total\nSub S(total)\n  x = 1 +\n  x = ) total\nEnd Sub\ny = ( total obj.total';
        assert.strictEqual(resolved(code, 'total', 4), 'parameter procedure@2');
        assert.strictEqual(resolved(code, 'total', 6), 'variable script@1');
        const { binding } = bindCode(code);
        assert.deepStrictEqual(binding.members.map(m => m.name), ['total']);
    });

    it('keeps a client-side VBScript block apart from the server code', () => {
        const text = '<% Dim x %>\n<script language="vbscript">\nDim x\n</script>';
        assert.deepStrictEqual(bindPage('page.asp', parsePage(text)).diagnostics, []);
    });
});

describe('binder — Name redefined', () => {
    const allowed = [
        'Sub A\nEnd Sub\nFunction A\nEnd Function',
        'Class C\nProperty Get P\nEnd Property\nProperty Let P(v)\nEnd Property\nProperty Set P(v)\nEnd Property\nEnd Class',
        'Dim x\nReDim x(3)',
        'Sub S\nReDim a(2)\nReDim a(3)\nEnd Sub',
        'Sub A\nDim A\nEnd Sub',
        'Dim a\nSub S\nDim a\nEnd Sub',
        'x = 1\nDim x',
        'Class C\nPublic x\nSub S\nDim x\nEnd Sub\nEnd Class',
        'Class C\nDim C\nEnd Class',
        'Function F\nReDim F(2)\nEnd Function',
    ];
    for (const code of allowed) {
        it(`allows ${JSON.stringify(code)}`, () => {
            assert.deepStrictEqual(redefinedLines(code), []);
        });
    }

    const rejected: [string, number][] = [
        ['Dim a, a', 1],
        ['Dim x\nConst x = 1', 2],
        ['Dim x\nClass x\nEnd Class', 2],
        ['Sub A\nEnd Sub\nDim A', 3],
        ['ReDim x(3)\nDim x', 2],
        ['Sub A(a, a)\nEnd Sub', 1],
        ['Sub A(a)\nDim a\nEnd Sub', 2],
        ['Dim a\nSub S\nReDim a(2)\nDim a\nEnd Sub', 4],
        ['Function F(F)\nEnd Function', 1],
        ['Function F\nConst F = 1\nEnd Function', 2],
        ['Class C\nSub A\nEnd Sub\nFunction A\nEnd Function\nEnd Class', 4],
        ['Class C\nProperty Get P\nEnd Property\nProperty Get P\nEnd Property\nEnd Class', 4],
        ['Class C\nProperty Let P(P)\nEnd Property\nEnd Class', 2],
    ];
    for (const [code, line] of rejected) {
        it(`reports ${JSON.stringify(code)} on line ${line}`, () => {
            assert.deepStrictEqual(redefinedLines(code), [line]);
        });
    }

    it('reports a name declared by both a page and its include, on the later one', () => {
        const host = site({ 'lib.inc': '<% Dim total %>' });
        const scope = buildScriptScope(at('page.asp'), '<!-- #include file="lib.inc" -->\n<% Dim total %>', host);
        const [d] = bindScriptScope(scope).diagnostics;
        assert.strictEqual(d.file, at('page.asp'));
        assert.strictEqual(d.message, 'Name redefined');
    });
});
