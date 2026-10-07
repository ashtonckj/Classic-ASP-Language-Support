import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkPage, globalAsaChecks, objectTagIds, type CheckCode } from '../../vbscript/checks';
import { bindAt, type WorkspaceHost } from '../../vbscript/references';
import { lineAt, parsePage } from '../../vbscript/symbols';
import { resolveIncludeDirective } from '../../utils/includeDirectives';
import { checkPageFiles, type ChecksRequest, type PageChecks } from '../../vbscript/pageChecks';
import { VBSCRIPT_CONSTANTS } from '../../constants/aspKeywords';

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

    // VBScript accepts a chain of & or . or (…) of any length, and the parser
    // builds each as a tree as deep as the chain is long.
    it('checks every call in a join, member chain or call chain thousands long', () => {
        const n = 50000;
        const code = `${procs}y = One(1)${' & One(1, 2)'.repeat(n)}\ny = o${'.p'.repeat(n)}\ny = One${'(1)'.repeat(n)}`;
        assert.strictEqual(checksOf(code, 'wrong-arguments').length, n);
    });

    // In the test run the checks are usually compiled to machine code by now,
    // with smaller stack frames, so only a fresh process shows the worst case.
    it('survives long chains in a fresh process, before the checks are compiled', () => {
        const module = (name: string) => JSON.stringify(path.join(__dirname, `../../vbscript/${name}.js`));
        const script = [
            `const { parsePage } = require(${module('symbols')});`,
            `const { bindPage } = require(${module('binder')});`,
            `const { checkPage } = require(${module('checks')});`,
            `for (const code of ['x = a' + ' & a'.repeat(8000), 'x = a' + '.b'.repeat(8000), 'x = a' + '(1)'.repeat(8000)]) {`,
            `    const page = parsePage('<%\\n' + code + '\\n%>');`,
            `    const bound = { path: 'page.asp', binding: bindPage('page.asp', page), pages: new Map([['page.asp', page]]), problems: [] };`,
            `    checkPage(bound, 'page.asp', new Set());`,
            `}`,
        ].join('\n');
        assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' }));
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

// On the worker thread the checks read the includes themselves: from disk, or
// as the editor holds them when they are open with unsaved changes.
describe('checkPageFiles — the checks with the includes read from disk', () => {
    let dir: string;
    const file = (name: string) => path.join(dir, name);
    const request = (text: string, extra: Partial<ChecksRequest> = {}): ChecksRequest => ({
        text, docPath: file('page.asp'), configuredRoot: dir, defaultIncludes: [], openFiles: {}, includeComVariables: [], ...extra,
    });
    const codes = (result: PageChecks) => result.checks.map(c => c.code);

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-checks-'));
        fs.writeFileSync(file('lib.inc'), '<%\nDim fromLib\n%>');
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('counts a name an include on disk declares', () => {
        const text = '<!--#include file="lib.inc"-->\n<%\nOption Explicit\nfromLib = 1\n%>';
        assert.deepStrictEqual(codes(checkPageFiles(request(text), (_p, t) => parsePage(t))), []);
    });

    it('reads an include open with unsaved changes as the editor holds it', () => {
        const text = '<!--#include file="lib.inc"-->\n<%\nOption Explicit\nfromLib = 1\n%>';
        const openFiles = { [file('lib.inc').toLowerCase()]: '<%\nDim renamed\n%>' };
        assert.deepStrictEqual(codes(checkPageFiles(request(text, { openFiles }), (_p, t) => parsePage(t))), ['undeclared']);
    });

    it('counts an object global.asa declares', () => {
        fs.writeFileSync(file('global.asa'), '<object runat="server" scope="application" id="Cache" progid="Scripting.Dictionary"></object>');
        try {
            const text = '<%\nOption Explicit\nCache.Add "a", 1\n%>';
            assert.deepStrictEqual(codes(checkPageFiles(request(text), (_p, t) => parsePage(t))), []);
        } finally {
            fs.rmSync(file('global.asa'));
        }
    });

    it("knows every constant the VBScript engine defines, so none is called undeclared", () => {
        // The engine's whole set, read from cscript.exe one name at a time under Option Explicit.
        const engine = [
            'vbCrLf', 'vbCr', 'vbLf', 'vbNewLine', 'vbTab', 'vbNullChar', 'vbNullString', 'vbFormFeed', 'vbVerticalTab',
            'vbObjectError', 'vbBinaryCompare', 'vbTextCompare', 'vbTrue', 'vbFalse', 'vbUseDefault',
            'vbSunday', 'vbMonday', 'vbTuesday', 'vbWednesday', 'vbThursday', 'vbFriday', 'vbSaturday',
            'vbUseSystemDayOfWeek', 'vbFirstJan1', 'vbFirstFourDays', 'vbFirstFullWeek', 'vbUseSystem',
            'vbGeneralDate', 'vbLongDate', 'vbShortDate', 'vbLongTime', 'vbShortTime',
            'vbEmpty', 'vbNull', 'vbInteger', 'vbLong', 'vbSingle', 'vbDouble', 'vbCurrency', 'vbDate', 'vbString',
            'vbObject', 'vbError', 'vbBoolean', 'vbVariant', 'vbDataObject', 'vbDecimal', 'vbByte', 'vbArray',
            'vbBlack', 'vbRed', 'vbGreen', 'vbYellow', 'vbBlue', 'vbMagenta', 'vbCyan', 'vbWhite',
            'vbOKOnly', 'vbOKCancel', 'vbAbortRetryIgnore', 'vbYesNoCancel', 'vbYesNo', 'vbRetryCancel',
            'vbCritical', 'vbQuestion', 'vbExclamation', 'vbInformation',
            'vbDefaultButton1', 'vbDefaultButton2', 'vbDefaultButton3', 'vbDefaultButton4',
            'vbApplicationModal', 'vbSystemModal', 'vbMsgBoxHelpButton', 'vbMsgBoxSetForeground', 'vbMsgBoxRight',
            'vbMsgBoxRtlReading', 'vbOK', 'vbCancel', 'vbAbort', 'vbRetry', 'vbIgnore', 'vbYes', 'vbNo',
        ];
        assert.deepStrictEqual(VBSCRIPT_CONSTANTS.map(c => c.name).sort(), [...engine].sort());
        const text = `<%\nOption Explicit\nDim x\n${engine.map(name => `x = ${name}`).join('\n')}\n%>`;
        assert.deepStrictEqual(codes(checkPageFiles(request(text), (_p, t) => parsePage(t))), []);
    });

    it('finds a Missing Set on an object whose type an include declares', () => {
        const text = '<%\nrs = conn.Execute("SELECT 1")\n%>';
        const includeComVariables = [{ name: 'conn', progId: 'adodb.connection' }];
        const result = checkPageFiles(request(text, { includeComVariables }), (_p, t) => parsePage(t));
        assert.deepStrictEqual(result.missingSet.map(m => m.target), ['rs']);
    });
});

// IIS's own rules for global.asa: code only in <script runat="Server">, and
// objects only with Application or Session scope.
describe('global.asa rules', () => {
    const asa = (text: string) => globalAsaChecks(text).map(c => text.slice(c.start, c.end).slice(0, 12));

    it('says nothing about a well-formed global.asa', () => {
        const text = '<object runat="Server" scope="Application" id="A" progid="Scripting.Dictionary"></object>\n' +
            '<script language="VBScript" runat="Server">\nSub Application_OnStart\n  A.Add "x", 1\nEnd Sub\n</script>';
        assert.deepStrictEqual(asa(text), []);
    });

    it('flags a <% %> block', () => {
        assert.deepStrictEqual(asa('<% Application("x") = 1 %>'), ['<%']);
    });

    it('flags an object with no scope, or the page scope', () => {
        assert.deepStrictEqual(asa('<object runat="Server" id="A" progid="x">\n<object runat=server scope=Page id=B progid=y>'),
            ['<object runa', '<object runa']);
    });

    it('is only for global.asa, not for a page', () => {
        const request = (docPath: string) => ({
            text: '<% x = 1 %>', docPath, configuredRoot: undefined, defaultIncludes: [], openFiles: {}, includeComVariables: [],
        });
        const codes = (docPath: string) => checkPageFiles(request(docPath), (_p, t) => parsePage(t)).checks.map(c => c.code);
        assert.deepStrictEqual(codes(path.join(os.tmpdir(), 'global.asa')), ['global-asa']);
        assert.deepStrictEqual(codes(path.join(os.tmpdir(), 'page.asp')), []);
    });
});
