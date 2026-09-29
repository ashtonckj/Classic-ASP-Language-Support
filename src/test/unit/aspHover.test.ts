import * as assert from 'assert';
import * as path from 'path';
import { describeDeclaration } from '../../providers/aspHoverProvider';
import { declarationsOf, resolveAt, type WorkspaceHost } from '../../vbscript/references';
import { parseIncludeDirectives, resolveIncludeDirective } from '../../utils/includeDirectives';

const root = path.resolve('/site');
const at = (p: string) => path.resolve(root, p);

function site(files: Record<string, string>): WorkspaceHost {
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

/** The hover of the `n`th `word` in page.asp. */
function hoverOf(files: Record<string, string>, word: string, n = 1, com: { name: string; progId: string }[] = []): string {
    const host = site(files);
    const text = files['page.asp'];
    let offset = -1;
    for (let i = 0; i < n; i++) { offset = text.indexOf(word, offset + 1); }
    const resolved = resolveAt(host, at('page.asp'), offset + 1);
    assert.ok(resolved, `nothing known of ${word} #${n}`);
    const decls = declarationsOf(resolved!.bound.binding, resolved!.target);
    return describeDeclaration(resolved!.bound, decls[decls.length - 1], at('page.asp'), com);
}

describe('hover on a name the page declares', () => {
    const page = [
        '<%',
        'Const LIMIT = 10',
        'Dim total',
        'Sub Report(total)',
        '  Dim i',
        '  Response.Write total & i',
        'End Sub',
        'Class Cart',
        '  Private items',
        '  Public Property Get Count()',
        '    Count = UBound(items)',
        '  End Property',
        'End Class',
        'Report total',
        '%>',
    ].join('\n');

    it('says a parameter belongs to its procedure', () => {
        assert.strictEqual(hoverOf({ 'page.asp': page }, 'total &'), '**total** — parameter of `Report`');
    });

    it('tells a local from a page variable', () => {
        assert.match(hoverOf({ 'page.asp': page }, 'i\n'), /^\*\*i\*\* — local variable of `Report`/);
        assert.match(hoverOf({ 'page.asp': page }, 'total\n%>'), /^\*\*total\*\* — variable\n\n\*Declared in this file\*$/);
    });

    it('shows a procedure with its parameters, and a class member as one', () => {
        assert.match(hoverOf({ 'page.asp': page }, 'Report total'), /^\*\*Sub Report\(total\)\*\*\n\n\*Defined in this file\*$/);
        assert.match(hoverOf({ 'page.asp': page }, 'Count', 2), /^\*\*Property Get Count\*\*\n\n\*Member of class `Cart`\*/);
        assert.match(hoverOf({ 'page.asp': page }, 'items', 2), /^\*\*items\*\* — member of class `Cart`/);
    });

    it("shows a constant's value", () => {
        assert.match(hoverOf({ 'page.asp': page + '<% x = LIMIT %>' }, 'LIMIT', 2), /^\*\*LIMIT\*\* = `10`/);
    });

    it('names the include a declaration comes from', () => {
        const files = { 'lib.inc': '<% Dim shared %>', 'page.asp': '<!-- #include file="lib.inc" -->\n<% shared = 1 %>' };
        assert.strictEqual(hoverOf(files, 'shared'), '**shared** — variable\n\n*Declared in `lib.inc`*');
    });

    it('gives an object variable its type', () => {
        const text = '<% Set rs = Server.CreateObject("ADODB.Recordset") : rs.Close %>';
        assert.match(hoverOf({ 'page.asp': text }, 'rs', 2, [{ name: 'rs', progId: 'adodb.recordset' }]), /^\*\*rs\*\* — `adodb.recordset`/);
    });
});
