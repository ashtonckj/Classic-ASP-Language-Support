import * as assert from 'assert';
import {
    computeLocalRenameScope,
    declaringFilesFor,
    findAllOccurrences,
    includeClosure,
    shadowingBodies,
} from '../../providers/aspRenameProvider';
import { FileSymbols } from '../../utils/symbolParser';

// F2 on a local variable/parameter must be limited to its own function
// body, not rewritten across every function and every file. computeLocalRenameScope
// returns that body's range for a local, or null for a global.
function fn(name: string, line: number, endLine: number, paramNames: string[] = []): FileSymbols['functions'][number] {
    return { name, kind: 'Sub', params: paramNames.join(', '), paramNames, line, endLine, filePath: 'x.asp' };
}

// Two subs, each with its own local `i`; one module-level `total`.
//  line 2  Sub First()
//  line 3    Dim i
//  line 4    For i = 1 To 3 : Next
//  line 5  End Sub
//  line 7  Sub Second()
//  line 8    Dim i
//  line 9    i = 99
//  line 10 End Sub
//  line 12 Dim total   (module level)
const SYM: FileSymbols = {
    variables: [
        { name: 'i',     line: 3,  filePath: 'x.asp' },
        { name: 'i',     line: 8,  filePath: 'x.asp' },
        { name: 'total', line: 12, filePath: 'x.asp' },
    ],
    constants: [],
    functions: [fn('First', 2, 5), fn('Second', 7, 10)],
    comVariables: [],
    classes: [],
};

describe('computeLocalRenameScope', () => {
    it('restricts a local Dim to its own function body', () => {
        assert.deepStrictEqual(computeLocalRenameScope(SYM, 3, 'i'), { line: 2, endLine: 5 });
    });

    it('gives a different (correct) body for the other function\'s local', () => {
        assert.deepStrictEqual(computeLocalRenameScope(SYM, 8, 'i'), { line: 7, endLine: 10 });
    });

    it('returns null for a module-level variable (rename stays global)', () => {
        assert.strictEqual(computeLocalRenameScope(SYM, 12, 'total'), null);
    });

    it('returns null for a function name used inside a body (functions are global)', () => {
        // caret inside First (line 4) on a call to Second → Second is global.
        assert.strictEqual(computeLocalRenameScope(SYM, 4, 'second'), null);
    });

    it('treats a parameter as local to its function', () => {
        const sym: FileSymbols = { ...SYM, functions: [fn('Greet', 2, 4, ['who'])] };
        assert.deepStrictEqual(computeLocalRenameScope(sym, 3, 'who'), { line: 2, endLine: 4 });
    });

    it('returns null when the caret is not inside any function body', () => {
        assert.strictEqual(computeLocalRenameScope(SYM, 0, 'i'), null);
    });
});

// The occurrence scanner used to decide "is this token inside a VBScript comment?"
// by reading the physical line from column 0. A single ASP line often mixes HTML
// and script, so an apostrophe in ordinary HTML text ("it's", class='box') looked
// like a comment marker and every occurrence after it on that line was skipped —
// leaving a half-renamed file.
describe('findAllOccurrences — HTML apostrophe on a mixed line', () => {
    const at = (text: string, line: number) =>
        findAllOccurrences(text, 'total').filter(o => o.line === line);

    const mixed = [
        '<%  Dim total  %>',
        '<table>',
        "  <td>it's here</td><% total = total + 1 %>",
        '</table>',
        '<% Response.Write total %>',
        '',
    ].join('\n');

    it('finds both occurrences after an apostrophe in the HTML part', () => {
        assert.strictEqual(at(mixed, 2).length, 2);
    });

    it('still finds the declaration and the later use', () => {
        assert.strictEqual(at(mixed, 0).length, 1);
        assert.strictEqual(at(mixed, 4).length, 1);
    });

    it('reports the right columns on the mixed line', () => {
        const cols = at(mixed, 2).map(o => o.character);
        assert.deepStrictEqual(cols, [mixed.split('\n')[2].indexOf('total'), mixed.split('\n')[2].lastIndexOf('total')]);
    });

    it('matches the "it is" control line, as it always did', () => {
        const control = '<%  Dim total  %>\n<td>it is here</td><% total = total + 1 %>\n';
        assert.strictEqual(findAllOccurrences(control, 'total').filter(o => o.line === 1).length, 2);
    });

    // The apostrophe fix must not stop real VBScript comments being skipped.
    it('still skips a token inside a real VBScript comment', () => {
        const commented = "<% Dim total\n' total = total + 1\nResponse.Write total %>\n";
        assert.deepStrictEqual(
            findAllOccurrences(commented, 'total').map(o => o.line),
            [0, 2],
        );
    });

    it('still skips a token inside a VBScript string', () => {
        const inString = '<% Dim total\nResponse.Write "total is " & total %>\n';
        const cols = findAllOccurrences(inString, 'total').filter(o => o.line === 1).map(o => o.character);
        assert.deepStrictEqual(cols, [inString.split('\n')[1].lastIndexOf('total')]);
    });
});

// prepareRename allows F2 inside a <script language="vbscript"> block (the zone
// resolver correctly calls it VBScript), but the occurrence scanner only mapped
// <% … %> blocks — so the rename found nothing and silently did nothing.
describe('findAllOccurrences — VBScript <script> blocks', () => {
    const clientSide = [
        '<script language="vbscript">',
        '  Dim total',
        '  total = 1',
        '  Response.Write total',
        '</script>',
        '',
    ].join('\n');

    it('finds occurrences inside a client-side VBScript block', () => {
        assert.deepStrictEqual(
            findAllOccurrences(clientSide, 'total').map(o => o.line),
            [1, 2, 3],
        );
    });

    it('finds occurrences inside a runat="server" VBScript block', () => {
        const serverSide = '<script runat="server" language="vbscript">\n  Sub Greet(name)\n  End Sub\n</script>\n';
        assert.deepStrictEqual(findAllOccurrences(serverSide, 'Greet').map(o => o.line), [1]);
    });

    it('matches type="text/vbscript" as well as language=', () => {
        const typed = '<script type="text/vbscript">\n  Dim total\n</script>\n';
        assert.strictEqual(findAllOccurrences(typed, 'total').length, 1);
    });

    it('leaves a plain JavaScript <script> block alone', () => {
        const js = '<script>\n  var total = 1;\n  total = total + 1;\n</script>\n';
        assert.deepStrictEqual(findAllOccurrences(js, 'total'), []);
    });

    it('does not reach past </script> into the surrounding HTML', () => {
        const mixed = '<script language="vbscript">\n  Dim total\n</script>\n<p>total in prose</p>\n';
        assert.deepStrictEqual(findAllOccurrences(mixed, 'total').map(o => o.line), [1]);
    });

    it('still finds occurrences in <% %> blocks on the same page', () => {
        const both = '<script language="vbscript">\n  Dim total\n</script>\n<% Response.Write total %>\n';
        assert.deepStrictEqual(findAllOccurrences(both, 'total').map(o => o.line), [1, 3]);
    });
});

// ── Script scope ─────────────────────────────────────────────────────────────
// Classic ASP has two scopes: procedure scope, and the script scope formed by a
// page plus everything it textually #includes. Rename used to search every
// .asp/.inc in the workspace, so F2 on a common name rewrote it in unrelated
// pages that could never see the declaration.
describe('includeClosure', () => {
    //  page1.asp -> lib.inc
    //  page2.asp -> lib.inc, util.inc
    //  other.asp -> (nothing)
    //  orphan.inc is included by nobody
    const SITE = new Map<string, string[]>([
        ['c:/site/page1.asp',  ['c:/site/lib.inc']],
        ['c:/site/page2.asp',  ['c:/site/lib.inc', 'c:/site/util.inc']],
        ['c:/site/other.asp',  []],
        ['c:/site/lib.inc',    []],
        ['c:/site/util.inc',   []],
        ['c:/site/orphan.inc', []],
    ]);

    const closure = (seed: string) => [...includeClosure(SITE, seed)].sort();

    it('reaches the pages that include a .inc', () => {
        assert.deepStrictEqual(closure('c:/site/lib.inc'), [
            'c:/site/lib.inc', 'c:/site/page1.asp', 'c:/site/page2.asp', 'c:/site/util.inc',
        ]);
    });

    it('includes siblings that share a page with the declaration', () => {
        // util.inc is only reachable via page2.asp, but page2 splices both files
        // into one script scope, so a name declared in lib.inc is visible there.
        assert.ok(closure('c:/site/lib.inc').includes('c:/site/util.inc'));
    });

    it('never reaches a page with no include relationship', () => {
        assert.deepStrictEqual(closure('c:/site/other.asp'), ['c:/site/other.asp']);
        assert.ok(!closure('c:/site/lib.inc').includes('c:/site/other.asp'));
    });

    it('is just the page and its own includes when seeded from a page', () => {
        assert.deepStrictEqual(closure('c:/site/page1.asp'), ['c:/site/lib.inc', 'c:/site/page1.asp']);
    });

    it('is the file alone for an include nobody uses', () => {
        assert.deepStrictEqual(closure('c:/site/orphan.inc'), ['c:/site/orphan.inc']);
    });

    it('terminates on circular includes', () => {
        const cyclic = new Map<string, string[]>([['a', ['b']], ['b', ['c']], ['c', ['a']]]);
        assert.deepStrictEqual([...includeClosure(cyclic, 'a')].sort(), ['a', 'b', 'c']);
    });

    it('returns the seed alone when it is not in the graph', () => {
        assert.deepStrictEqual([...includeClosure(SITE, 'c:/elsewhere/new.asp')], ['c:/elsewhere/new.asp']);
    });
});

describe('declaringFilesFor', () => {
    const symbolsWith = (over: Partial<FileSymbols>): FileSymbols => ({
        variables: [], constants: [], functions: [], comVariables: [], classes: [], ...over,
    });

    it('finds the include that declares a Sub, not the page using it', () => {
        const sym = symbolsWith({ functions: [{ ...fn('RenderHeader', 5, 8), filePath: 'lib.inc' }] });
        assert.deepStrictEqual(declaringFilesFor(sym, 'renderheader'), ['lib.inc']);
    });

    it('matches case-insensitively, as VBScript does', () => {
        const sym = symbolsWith({ variables: [{ name: 'Total', line: 1, filePath: 'page.asp' }] });
        assert.deepStrictEqual(declaringFilesFor(sym, 'total'), ['page.asp']);
    });

    it('returns every declaring file so the rename covers all their scopes', () => {
        const sym = symbolsWith({
            variables: [
                { name: 'total', line: 1, filePath: 'page.asp' },
                { name: 'total', line: 2, filePath: 'lib.inc' },
            ],
        });
        assert.deepStrictEqual(declaringFilesFor(sym, 'total').sort(), ['lib.inc', 'page.asp']);
    });

    it('returns nothing for a name it does not know', () => {
        assert.deepStrictEqual(declaringFilesFor(symbolsWith({}), 'nosuch'), []);
    });
});

// Renaming a module-level name must not reach into a procedure where the same
// name is a different variable.
describe('shadowingBodies', () => {
    const base = (over: Partial<FileSymbols>): FileSymbols => ({
        variables: [], constants: [], functions: [], comVariables: [], classes: [], ...over,
    });

    it('skips a body whose PARAMETER shadows the name', () => {
        const sym = base({ functions: [fn('Add', 4, 7, ['total'])] });
        assert.deepStrictEqual(shadowingBodies(sym, 'total'), [{ line: 4, endLine: 7 }]);
    });

    it('skips a body with an explicit Dim of the name', () => {
        const sym = base({
            functions: [fn('Other', 9, 12)],
            variables: [{ name: 'total', line: 10, filePath: 'x.asp' }],
        });
        assert.deepStrictEqual(shadowingBodies(sym, 'total'), [{ line: 9, endLine: 12 }]);
    });

    it('skips a body with a local Const of the name', () => {
        const sym = base({
            functions: [fn('Other', 9, 12)],
            constants: [{ name: 'total', value: '1', line: 10, filePath: 'x.asp' }],
        });
        assert.deepStrictEqual(shadowingBodies(sym, 'total'), [{ line: 9, endLine: 12 }]);
    });

    // VBScript does not declare a local on assignment — inside a procedure a bare
    // `total = 1` is the module-level variable, so that body MUST be renamed.
    it('does not skip a body that only assigns the name implicitly', () => {
        const sym = base({
            functions: [fn('Uses', 14, 16)],
            variables: [{ name: 'total', line: 15, filePath: 'x.asp', implicit: true }],
        });
        assert.deepStrictEqual(shadowingBodies(sym, 'total'), []);
    });

    it('does not skip a body that only uses the name as a For Each variable', () => {
        const sym = base({
            functions: [fn('Loop1', 20, 24)],
            variables: [{ name: 'item', line: 21, filePath: 'x.asp', implicit: true }],
        });
        assert.deepStrictEqual(shadowingBodies(sym, 'item'), []);
    });

    it('returns nothing when no procedure shadows the name', () => {
        assert.deepStrictEqual(shadowingBodies(SYM, 'total'), []);
    });

    it('ignores a declaration that sits outside every body', () => {
        const sym = base({
            functions: [fn('Add', 4, 7)],
            variables: [{ name: 'total', line: 1, filePath: 'x.asp' }],
        });
        assert.deepStrictEqual(shadowingBodies(sym, 'total'), []);
    });

    it('ignores a procedure whose end line was never resolved', () => {
        const sym = base({ functions: [fn('Broken', 3, -1, ['total'])] });
        assert.deepStrictEqual(shadowingBodies(sym, 'total'), []);
    });
});
