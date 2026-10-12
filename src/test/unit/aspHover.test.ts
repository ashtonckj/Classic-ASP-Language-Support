import * as assert from 'assert';
import * as path from 'path';
import { describeDeclaration, keywordPhraseAt } from '../../asp/aspHoverProvider';
import { declarationsOf, resolveAt, type WorkspaceHost } from '../../vbscript/references';
import { parseIncludeDirectives, resolveIncludeDirective } from '../../core/includeDirectives';

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
        const files = { 'lib.inc': '<% Dim tally %>', 'page.asp': '<!-- #include file="lib.inc" -->\n<% tally = 1 %>' };
        assert.strictEqual(hoverOf(files, 'tally'), '**tally** — variable\n\n*Declared in `lib.inc`*');
    });

    it('gives an object variable its type', () => {
        const text = '<% Set rs = Server.CreateObject("ADODB.Recordset") : rs.Close %>';
        assert.match(hoverOf({ 'page.asp': text }, 'rs', 2, [{ name: 'rs', progId: 'adodb.recordset' }]), /^\*\*rs\*\* — `adodb.recordset`/);
    });
});

// A keyword's hover is the longest documented phrase it is part of, spanning all of it.
describe('keywordPhraseAt', () => {
    /** The phrase the hover over `word` in `line` covers, as text. */
    const phraseOver = (line: string, word: string) => {
        const start = line.indexOf(word);
        const found = keywordPhraseAt(line, start, start + word.length);
        return found && line.slice(found.start, found.end);
    };

    it('covers the whole of On Error Resume Next and On Error GoTo 0 from any of their words', () => {
        for (const word of ['On', 'Error', 'Resume', 'Next']) {
            assert.strictEqual(phraseOver('  On Error Resume Next', word), 'On Error Resume Next', word);
        }
        for (const word of ['On', 'Error', 'GoTo', '0']) {
            assert.strictEqual(phraseOver('On  Error GoTo 0 ', word), 'On  Error GoTo 0', word);
        }
    });

    it('covers a two-word keyword from either word', () => {
        assert.strictEqual(phraseOver('End If', 'If'), 'End If');
        assert.strictEqual(phraseOver('Exit For', 'For'), 'Exit For');
        assert.strictEqual(phraseOver('For Each item In list', 'Each'), 'For Each');
        assert.strictEqual(phraseOver('Do While x', 'While'), 'Do While');
        assert.strictEqual(phraseOver('Loop Until done', 'Until'), 'Loop Until');
    });

    it('stops at anything but whitespace, and falls back to the word alone', () => {
        assert.strictEqual(phraseOver('x = 1 : Next', 'Next'), 'Next');
        assert.strictEqual(phraseOver('If a Then', 'If'), 'If');
        assert.strictEqual(phraseOver('total = 1', 'total'), undefined);
    });
});
