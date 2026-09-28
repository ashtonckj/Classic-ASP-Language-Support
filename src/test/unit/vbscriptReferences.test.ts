import * as assert from 'assert';
import * as path from 'path';
import { findSites, type WorkspaceHost } from '../../vbscript/references';
import { parseIncludeDirectives, resolveIncludeDirective } from '../../utils/includeDirectives';

/** A workspace over an in-memory site, with the site root as the virtual root. */
function site(files: Record<string, string>): WorkspaceHost {
    const root = path.resolve('/site');
    const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');
    const resolve = (d: Parameters<WorkspaceHost['resolve']>[0], from: string) => resolveIncludeDirective(d, from, root);
    return {
        read: p => (rel(p) in files ? files[rel(p)] : null),
        resolve,
        includedBy: p => Object.keys(files)
            .filter(f => parseIncludeDirectives(files[f]).some(d => rel(resolve(d, at(f))) === rel(p)))
            .map(at),
    };
}

const at = (p: string) => path.resolve('/site', p);

/** The sites of the name written at the `n`th `word` of `file`, as "file:line:col", declarations starred. */
function sitesOf(host: WorkspaceHost, file: string, word: string, n = 1): string[] | null {
    const text = host.read(at(file))!;
    let offset = -1;
    for (let i = 0; i < n; i++) { offset = text.indexOf(word, offset + 1); }
    assert.ok(offset >= 0, `no ${word} #${n} in ${file}`);
    const found = findSites(host, at(file), offset + 1);
    return found && found
        .map(s => `${path.basename(s.file)}:${s.line}:${s.character}${s.declaration ? '*' : ''}`)
        .sort();
}

describe('findSites — which uses are the same name', () => {
    const one = (code: string) => site({ 'page.asp': code });

    it('keeps a local inside its own procedure', () => {
        const host = one([
            '<%',
            'Sub First()',
            '  Dim i',
            '  i = 1',
            'End Sub',
            'Sub Second()',
            '  Dim i',
            '  i = 2',
            'End Sub',
            'i = 3',
            '%>',
        ].join('\n'));
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'i =', 1), ['page.asp:2:6*', 'page.asp:3:2']);
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'i = 3'), ['page.asp:9:0']);
    });

    it('leaves out a procedure that declares its own copy of a page variable', () => {
        const host = one([
            '<%',
            'Dim total',                          // 1
            'Sub Add(total)',                     // 2
            '  Response.Write total',             // 3
            'End Sub',
            'Sub Other()',                        // 5
            '  Dim total : total = 0',            // 6
            'End Sub',
            'Sub Uses()',                         // 8
            '  total = total + 1',                // 9
            'End Sub',
            'Response.Write total',               // 11
            '%>',
        ].join('\n'));
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'total'), [
            'page.asp:11:15', 'page.asp:1:4*', 'page.asp:9:10', 'page.asp:9:2',
        ].sort());
    });

    it('treats a name only assigned in a Sub as that Sub\'s own when the page has none', () => {
        const host = one('<%\nSub A()\n  n = 1\nEnd Sub\nSub B()\n  n = 2\nEnd Sub\n%>');
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'n = 1'), ['page.asp:2:2']);
    });

    it('skips strings, comments, HTML and members of other objects', () => {
        const host = one([
            '<p>total</p>',
            '<% Dim total',
            'x = "total" \' total',
            'total = obj.total + 1',
            'With obj : .total = total : End With %>',
            "<td>it's here</td><% total = total + 1 %>",
        ].join('\n'));
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'total', 2), [
            'page.asp:1:7*', 'page.asp:3:0', 'page.asp:4:20', 'page.asp:5:21', 'page.asp:5:29',
        ]);
    });

    it("counts a Function's return value as the Function", () => {
        const host = one('<%\nFunction Twice(x)\n  Twice = x * 2\nEnd Function\ny = Twice(2)\n%>');
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'Twice', 3), ['page.asp:1:9*', 'page.asp:2:2', 'page.asp:4:4']);
    });

    it('finds a class member inside the class, through Me, and as obj.name', () => {
        const host = one([
            '<%',
            'Class Cart',
            '  Private items',                       // 2
            '  Public Sub Put(v) : items = v : End Sub',
            '  Public Function All() : All = Me.items : End Function',
            'End Class',
            'Set c = New Cart',
            'Response.Write c.items',                 // 7
            'items = 1',                              // 8: a page variable, not the member
            '%>',
        ].join('\n'));
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'items'), [
            'page.asp:2:10*', 'page.asp:3:22', 'page.asp:4:35', 'page.asp:7:17',
        ]);
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'items', 5), ['page.asp:8:0']);
    });

    it('keeps a client-side script apart from the server code', () => {
        const host = one('<% Dim total : total = 1 %>\n<script language="vbscript">\nDim total\ntotal = 2\n</script>');
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'total'), ['page.asp:0:15', 'page.asp:0:7*']);
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'total', 3), ['page.asp:2:4*', 'page.asp:3:0']);
    });

    it('renames inside the brackets of a bracketed name', () => {
        const host = one('<%\nDim [my total]\n[my total] = 1\n%>');
        assert.deepStrictEqual(sitesOf(host, 'page.asp', 'my total'), ['page.asp:1:5*', 'page.asp:2:1']);
    });

    it('knows nothing of a built-in object or a name never declared', () => {
        const host = one('<%\nOption Explicit\nResponse.Write x\n%>');
        assert.strictEqual(sitesOf(host, 'page.asp', 'Response'), null);
        assert.strictEqual(sitesOf(host, 'page.asp', 'x'), null);
    });
});

describe('findSites — pages and their includes', () => {
    //  page1.asp -> lib.inc
    //  page2.asp -> lib.inc, util.inc
    //  other.asp -> nothing
    const host = site({
        'lib.inc': '<%\nDim total\nSub Bump()\n  total = total + 1\nEnd Sub\n%>',
        'util.inc': '<%\nSub Show()\n  Response.Write total\nEnd Sub\n%>',
        'page1.asp': '<!-- #include file="lib.inc" -->\n<% total = 0 : Bump %>',
        'page2.asp': '<!-- #include file="lib.inc" -->\n<!-- #include file="util.inc" -->\n<% Bump : Show %>',
        'other.asp': '<% Dim total : total = 5 %>',
    });

    const everywhere = [
        'lib.inc:1:4*', 'lib.inc:3:10', 'lib.inc:3:2', 'page1.asp:1:3', 'util.inc:2:17',
    ];

    it('reaches every page that includes the declaring file, and their other includes', () => {
        assert.deepStrictEqual(sitesOf(host, 'lib.inc', 'total'), everywhere);
    });

    it('finds the same from a page that uses the name', () => {
        assert.deepStrictEqual(sitesOf(host, 'page1.asp', 'total'), everywhere);
    });

    it('finds the same from an include that only uses a name its pages declare', () => {
        assert.deepStrictEqual(sitesOf(host, 'util.inc', 'total'), everywhere);
    });

    it('never reaches a page that does not include the declaring file', () => {
        assert.deepStrictEqual(sitesOf(host, 'other.asp', 'total'), ['other.asp:0:15', 'other.asp:0:7*']);
    });

    it('finds a Sub from the pages that call it', () => {
        assert.deepStrictEqual(sitesOf(host, 'page2.asp', 'Bump'), ['lib.inc:2:4*', 'page1.asp:1:15', 'page2.asp:2:3']);
    });

    it('follows a shared include to the other pages that include it', () => {
        // Both pages make their own `cmpy` by assigning it; nav.inc uses it too,
        // so renaming it from one page has to rename it in the other as well.
        const shared = site({
            'nav.inc': '<% Response.Write cmpy %>',
            'hod.asp': '<% cmpy = "A" %>\n<!-- #include file="nav.inc" -->',
            'kpi.asp': '<% cmpy = "B" %>\n<!-- #include file="nav.inc" -->',
            'alone.asp': '<% cmpy = "C" %>',
        });
        assert.deepStrictEqual(sitesOf(shared, 'hod.asp', 'cmpy'), ['hod.asp:0:3', 'kpi.asp:0:3', 'nav.inc:0:18']);
    });

    it('stops on a file that includes itself', () => {
        const loop = site({
            'a.inc': '<!-- #include file="b.inc" -->\n<% Dim n %>',
            'b.inc': '<!-- #include file="a.inc" -->\n<% n = 1 %>',
        });
        assert.deepStrictEqual(sitesOf(loop, 'a.inc', 'n %>'), ['a.inc:1:7*', 'b.inc:1:3']);
    });
});

describe('findSites — speed', () => {
    const lines: string[] = ['<%', 'Dim total'];
    for (let i = 0; i < 12000; i++) { lines.push(i % 3 === 0 ? 'total = total + ' + i : 'x = ' + i); }
    lines.push('%>');
    const host = site({ 'big.asp': lines.join('\r\n') });

    it('finds every use in a large page, quickly', () => {
        const started = Date.now();
        const found = sitesOf(host, 'big.asp', 'total')!;
        const elapsed = Date.now() - started;
        assert.strictEqual(found.length, 1 + 2 * 4000);
        // Deliberately loose, so it measures the algorithm rather than the machine.
        assert.ok(elapsed < 2000, `expected well under 2s, took ${elapsed}ms`);
    });
});
