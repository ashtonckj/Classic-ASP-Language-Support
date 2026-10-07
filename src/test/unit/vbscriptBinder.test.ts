import * as assert from 'assert';
import { execFileSync } from 'child_process';
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

    it('finds a local of a Sub from a use written above the line that makes it', () => {
        // Checked against cscript.exe: the read sees the Sub's own local, Empty on every call.
        const loop = 'Sub S\n  Do While i < 10\n    i = i + 1\n  Loop\nEnd Sub';
        assert.strictEqual(resolved(loop, 'i', 2), 'variable (implicit) procedure@3');
        const redim = 'Option Explicit\nSub S\n  n = UBound(b)\n  ReDim b(2)\nEnd Sub';
        assert.strictEqual(resolved(redim, 'b', 3), 'variable procedure@4');
        // A page variable of that name, even one made further down, is still the one used.
        assert.strictEqual(resolved('Sub S\n  Response.Write i\n  i = 1\nEnd Sub\ni = 0', 'i', 2), 'variable (implicit) script@5');
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

    it('resizes a page array from a Sub with ReDim, and declares a local when there is none', () => {
        // Each checked against cscript.exe.
        assert.strictEqual(resolved('Sub S\n  ReDim a(3)\nEnd Sub\nDim a', 'a', 2), 'variable script@4');
        assert.strictEqual(resolved('x = 1\nSub T\n  ReDim x(2)\nEnd Sub', 'x', 3), 'variable (implicit) script@1');
        const local = 'Option Explicit\nSub S\n  ReDim b(2)\n  b(0) = 1\nEnd Sub';
        const { binding, lineOf } = bindCode(local);
        const b = binding.declarations.find(d => d.name === 'b')!;
        assert.strictEqual(`${b.scope.kind}@${lineOf(b.span.start)} ${b.implicit}`, 'procedure@3 false');
        assert.strictEqual(resolved(local, 'b', 4), 'variable procedure@3');
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

    it('lets client-side VBScript blocks use each other, as one browser engine runs them all', () => {
        // Checked with a .wsf of two script blocks under cscript.exe: the second
        // block's Hello is the one that runs, a Sub sees a variable a later block
        // makes, and Dim x in both blocks is no error.
        const text = [
            '<script language="vbscript">',   // 0
            'Dim x',                          // 1
            'Sub Hello()',                    // 2
            '  Show y',                       // 3
            'End Sub',                        // 4
            '</script>',                      // 5
            '<script language="vbscript">',   // 6
            'Dim x',                          // 7
            'y = 5',                          // 8
            'Sub Show(v)',                    // 9
            'End Sub',                        // 10
            'Hello',                          // 11
            '</script>',
        ].join('\n');
        const parsed = parsePage(text);
        const binding = bindPage('page.asp', parsed);
        const target = (name: string, line: number) => {
            const ref = binding.references.find(r => !r.declaration && r.name === name && lineAt(parsed, r.span.start) === line);
            return ref?.target ? `${ref.target.kind} ${lineAt(parsed, ref.target.span.start)}` : null;
        };
        assert.strictEqual(target('show', 3), 'sub 9');
        assert.strictEqual(target('y', 3), 'variable 8');
        assert.strictEqual(target('hello', 11), 'sub 2');
        assert.deepStrictEqual(binding.diagnostics, []);
    });

    it('still reports a name declared twice inside one client-side block', () => {
        const text = '<script language="vbscript">\nDim x\nDim x\n</script>';
        assert.deepStrictEqual(bindPage('page.asp', parsePage(text)).diagnostics.map(d => d.message), ['Name redefined']);
    });
});

// VBScript accepts a chain of & or . or (…) of any length, and the parser
// builds each as a tree as deep as the chain is long.
describe('binder — chains thousands long', () => {
    it('reads every name in a long join, member chain and call chain, in the order written', () => {
        const n = 50000;
        const { binding, lineOf } = bindCode(`x = a${' & a'.repeat(n)}\ny = o${'.p'.repeat(n)}\nz = f${'(i)'.repeat(n)}`);
        const uses = (name: string) => binding.references.filter(r => r.name === name && !r.declaration);
        assert.strictEqual(uses('a').length, n + 1);
        assert.strictEqual(uses('i').length, n);
        assert.deepStrictEqual(uses('o').map(r => lineOf(r.span.start)), [2]);
        assert.strictEqual(binding.members.length, n);
        assert.ok(binding.members.every((m, k) => m.name === 'p' && (k === 0 || binding.members[k - 1].span.start < m.span.start)));
    });

    // In the test run the binder is usually compiled to machine code by now,
    // with smaller stack frames, so only a fresh process shows the worst case.
    it('binds a page with 10,000 broken lines without slowing down', () => {
        // Every name on a broken line is looked up in the statement around it,
        // which was once a scan of the whole page per name.
        const code = Array.from({ length: 10000 }, (_, i) => `x${i} = ) a b c`).join('\n');
        const parsed = parsePage(page(code));
        const started = Date.now();
        const binding = bindPage('page.asp', parsed);
        assert.ok(binding.references.filter(r => r.name === 'a').length === 10000);
        assert.ok(Date.now() - started < 800, `took ${Date.now() - started} ms`);
    });

    it('survives long chains in a fresh process, before the binder is compiled', () => {
        const symbols = path.join(__dirname, '../../vbscript/symbols.js');
        const binder = path.join(__dirname, '../../vbscript/binder.js');
        const script = [
            `const { parsePage } = require(${JSON.stringify(symbols)});`,
            `const { bindPage } = require(${JSON.stringify(binder)});`,
            `for (const code of ['x = a' + ' & a'.repeat(8000), 'x = a' + '.b'.repeat(8000), 'x = a' + '(1)'.repeat(8000)]) {`,
            `    bindPage('page.asp', parsePage('<%\\n' + code + '\\n%>'));`,
            `}`,
        ].join('\n');
        assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' }));
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
        'Dim a\nSub S\nDim a\nReDim a(2)\nEnd Sub',
        'Dim a\nSub S\nReDim a(2)\nEnd Sub\nSub T\nDim a\nEnd Sub',
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
        ['Sub S\nReDim a(2)\nDim a\nEnd Sub', 3],
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
