import * as assert from 'assert';
import * as path from 'path';
import { checkPage, objectTagIds, type CheckCode } from '../../vbscript/checks';
import { bindAt, type WorkspaceHost } from '../../vbscript/references';
import { lineAt, parsePage } from '../../vbscript/symbols';
import { resolveIncludeDirective } from '../../utils/includeDirectives';

// The engine's behaviour behind each check was confirmed with cscript.exe:
// a wrong argument count is error 450, an undeclared name under Option
// Explicit is error 500, and inside Function F a bare F is its return value.

const root = path.resolve('/site');
const at = (p: string) => path.resolve(root, p);
const BUILTINS = new Set(['response', 'request', 'server', 'err', 'len', 'mid', 'vbcrlf']);

function site(files: Record<string, string>): WorkspaceHost {
    const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');
    return {
        read: p => (rel(p) in files ? files[rel(p)] : null),
        resolve: (d, from) => resolveIncludeDirective(d, from, root),
        includedBy: () => [],
    };
}

/** "line code" for each check on page.asp, lines counted from 1 inside the code. */
function checksOf(code: string, only?: CheckCode, files: Record<string, string> = {}): string[] {
    const text = `<%\n${code}\n%>`;
    const bound = bindAt(site({ ...files, 'page.asp': text }), at('page.asp'))!;
    const parsed = parsePage(text);
    return checkPage(bound, at('page.asp'), BUILTINS)
        .filter(c => !only || c.code === only)
        .map(c => `${lineAt(parsed, c.start)} ${c.code}${only ? ` ${text.slice(c.start, c.end).split('\n')[0]}` : ''}`);
}

describe('checks — a name declared twice', () => {
    it('reports the second declaration', () => {
        assert.deepStrictEqual(checksOf('Dim a\nDim a', 'name-redefined'), ['2 name-redefined a']);
    });
});

describe('checks — a name nothing declares, under Option Explicit', () => {
    it('reports every use of an undeclared name, and nothing without Option Explicit', () => {
        assert.deepStrictEqual(checksOf('Option Explicit\nDim a\na = b + 1\nSub S\n  c = 2\nEnd Sub', 'undeclared'),
            ['3 undeclared b', '5 undeclared c']);
        assert.deepStrictEqual(checksOf('a = b + 1', 'undeclared'), []);
    });

    it('leaves built-in names, members and objects from <object> tags alone', () => {
        const code = 'Option Explicit\nResponse.Write Len(vbCrLf) & Err.Number\n%><object runat="server" id="conn" progid="ADODB.Connection"></object><%\nconn.Open';
        assert.deepStrictEqual(checksOf(code, 'undeclared'), []);
    });

    it('counts what an include declares, and says nothing when an include is missing', () => {
        const code = '%><!-- #include file="lib.inc" --><%\nOption Explicit\nshared = 1';
        assert.deepStrictEqual(checksOf(code, 'undeclared', { 'lib.inc': '<% Dim shared %>' }), []);
        assert.deepStrictEqual(checksOf(code.replace('lib.inc', 'gone.inc'), 'undeclared'), []);
    });
});

describe('checks — calls with the wrong number of arguments', () => {
    const procs = 'Sub Two(a, b)\nEnd Sub\nFunction One(x)\n  One = x\nEnd Function\n';

    it('reports too many and too few, however the call is written', () => {
        assert.deepStrictEqual(checksOf(procs + 'Two 1\nCall Two(1, 2, 3)\ny = One(1, 2)\ny = One\nTwo 1, 2\ny = One(3)', 'wrong-arguments'),
            ['6 wrong-arguments Two', '7 wrong-arguments Two', '8 wrong-arguments One', '9 wrong-arguments One']);
    });

    it("leaves a Function's own name inside it alone, and arrays indexed like calls", () => {
        const code = 'Function F(n)\n  F = F + n\nEnd Function\nDim arr(3)\narr(1) = 2';
        assert.deepStrictEqual(checksOf(code, 'wrong-arguments'), []);
    });
});

describe('checks — declared and never used', () => {
    it('reports a local variable or constant never used, but not a page variable or a parameter', () => {
        const code = 'Dim pageWide\nSub S(p)\n  Dim unused, used\n  Const LIMIT = 3\n  used = 1\nEnd Sub';
        assert.deepStrictEqual(checksOf(code, 'unused'), ['3 unused unused', '4 unused LIMIT']);
    });
});

describe('checks — code after Exit', () => {
    it('reports what follows an Exit in the same block, and not the rest of the procedure', () => {
        const code = 'Sub S(a)\n  If a Then\n    Exit Sub\n    x = 1\n  End If\n  y = 2\n  Exit Sub\n  z = 3\nEnd Sub';
        assert.deepStrictEqual(checksOf(code, 'unreachable'), ['4 unreachable x = 1', '8 unreachable z = 3']);
    });

    it('leaves a one-line If alone', () => {
        assert.deepStrictEqual(checksOf('Sub S(a)\n  If a Then Exit Sub\n  y = 2\nEnd Sub', 'unreachable'), []);
    });
});

describe('objectTagIds', () => {
    it('finds the ids of server-side object tags only', () => {
        const text = '<OBJECT RUNAT=Server SCOPE=Session ID=Cart PROGID="Scripting.Dictionary"></OBJECT>\n<object id="player" classid="x"></object>';
        assert.deepStrictEqual(objectTagIds(text), ['cart']);
    });
});
