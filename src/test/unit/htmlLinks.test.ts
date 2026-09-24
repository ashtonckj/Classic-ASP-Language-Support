import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { HtmlAttributeLinkProvider, resolveHtmlLink } from '../../providers/linkProvider';

// href / src links follow the rules VS Code's HTML support uses in a .html file.
// A root-relative `/images/x.gif` was resolved against the DRIVE root, so it never
// linked, and `page.asp?id=5` looked for a file literally named that. A .html
// file also links a page that does not exist yet (following it offers to create
// it), and does not treat an href written inside a script string as a link.

const ROOT = path.resolve('/site');
const PAGE = path.join(ROOT, 'admin', 'users.asp');

describe('resolveHtmlLink', () => {
    const resolved = (value: string) => resolveHtmlLink(value, PAGE, ROOT);

    it('resolves a relative path from the page\'s own folder', () => {
        assert.deepStrictEqual(resolved('edit.asp'), { file: path.join(ROOT, 'admin', 'edit.asp') });
        assert.deepStrictEqual(resolved('../index.asp'), { file: path.join(ROOT, 'index.asp') });
    });

    it('resolves a root-relative path from the site root', () => {
        assert.deepStrictEqual(resolved('/images/logo.gif'), { file: path.join(ROOT, 'images', 'logo.gif') });
    });

    it('drops the query string, and a fragment on another page', () => {
        assert.deepStrictEqual(resolved('edit.asp?id=5&mode=x'), { file: path.join(ROOT, 'admin', 'edit.asp') });
        assert.deepStrictEqual(resolved('/help.asp#faq'), { file: path.join(ROOT, 'help.asp') });
    });

    it('keeps a path whose query string is built by ASP', () => {
        assert.deepStrictEqual(resolved('edit.asp?id=<%= rs("id") %>'), { file: path.join(ROOT, 'admin', 'edit.asp') });
    });

    it('points a bare fragment at the page itself', () => {
        assert.deepStrictEqual(resolved('#top'), { fragment: 'top' });
        assert.deepStrictEqual(resolved('#'), { fragment: '' });
    });

    it('decodes %-escapes', () => {
        assert.deepStrictEqual(resolved('my%20page.asp'), { file: path.join(ROOT, 'admin', 'my page.asp') });
        assert.deepStrictEqual(resolved('100%.asp'), { file: path.join(ROOT, 'admin', '100%.asp') }, 'a bad escape is kept as written');
    });

    it('leaves URLs, other schemes and protocol-relative links alone', () => {
        for (const value of [
            'http://example.com/x', 'https://example.com', 'mailto:a@b.com', 'tel:123',
            'javascript:void(0)', 'data:image/png;base64,AAAA', '//cdn.example.com/x.js',
        ]) {
            assert.strictEqual(resolved(value), undefined, value);
        }
    });

    it('gives nothing for a path built by ASP, or an empty value', () => {
        assert.strictEqual(resolved('<%= base %>/x.asp'), undefined);
        assert.strictEqual(resolved(''), undefined);
        assert.strictEqual(resolved('   '), undefined);
    });
});

describe('HtmlAttributeLinkProvider', () => {
    before(() => { (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }]; });
    after(()  => { (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined; });

    function fakeDoc(text: string): vscode.TextDocument {
        const lineStarts = [0];
        for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { lineStarts.push(i + 1); } }
        return {
            uri: vscode.Uri.file(PAGE),
            getText: () => text,
            positionAt: (offset: number) => {
                let line = 0;
                while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) { line++; }
                return new vscode.Position(line, offset - lineStarts[line]);
            },
        } as unknown as vscode.TextDocument;
    }

    const linksIn = (text: string) =>
        (new HtmlAttributeLinkProvider().provideDocumentLinks(fakeDoc(text)) as vscode.DocumentLink[])
            .map(link => ({
                text:     text.split('\n')[link.range.start.line].slice(link.range.start.character, link.range.end.character),
                target:   link.target!.fsPath,
                fragment: link.target!.fragment,
            }));

    it('links a page that does not exist yet, the way .html does', () => {
        assert.deepStrictEqual(linksIn('<a href="not-written-yet.asp">x</a>'), [
            { text: 'not-written-yet.asp', target: path.join(ROOT, 'admin', 'not-written-yet.asp'), fragment: '' },
        ]);
    });

    it('underlines the whole value, query string included', () => {
        assert.deepStrictEqual(linksIn('<a href="/edit.asp?id=5">x</a>').map(l => l.text), ['/edit.asp?id=5']);
    });

    it('links single-quoted and unquoted values', () => {
        assert.deepStrictEqual(
            linksIn("<img src='a.gif'>\n<a href=b.asp>x</a>").map(l => l.text),
            ['a.gif', 'b.asp'],
        );
    });

    it('links a fragment to the page itself', () => {
        assert.deepStrictEqual(linksIn('<a href="#top">up</a>'), [{ text: '#top', target: PAGE, fragment: 'top' }]);
    });

    it('does not link an href written inside VBScript or JavaScript', () => {
        const text = [
            '<% Response.Write "<a href=\'edit.asp\'>x</a>" %>',
            '<script>',
            '  img.src = "logo.gif";',
            '</script>',
            '<a href="real.asp">x</a>',
        ].join('\n');
        assert.deepStrictEqual(linksIn(text).map(l => l.text), ['real.asp']);
    });

    it('still links an attribute whose value holds an ASP expression in its query', () => {
        assert.deepStrictEqual(linksIn('<a href="edit.asp?id=<%= id %>">x</a>').map(l => l.target), [path.join(ROOT, 'admin', 'edit.asp')]);
    });
});
