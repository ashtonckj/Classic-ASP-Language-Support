import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HtmlAttributeLinkProvider, HtmlAttributePathCompletionProvider, resolveHtmlLink } from '../../html/linkProvider';
import { fakeDocument } from './_helpers';

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

    const fakeDoc = (text: string): vscode.TextDocument => fakeDocument(text, { uri: vscode.Uri.file(PAGE) });

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

// Files are offered where a .html file offers them: in a link attribute of the
// page's own markup, the folders resolved as the links resolve them.
describe('HtmlAttributePathCompletionProvider', () => {
    let site: string;

    before(() => {
        site = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-links-'));
        fs.mkdirSync(path.join(site, 'admin'));
        fs.mkdirSync(path.join(site, 'images'));
        fs.writeFileSync(path.join(site, 'admin', 'edit.asp'), '');
        fs.writeFileSync(path.join(site, 'images', 'logo.gif'), '');
        (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: site } }];
    });
    after(() => {
        (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
        fs.rmSync(site, { recursive: true, force: true });
    });

    const offered = async (text: string) => {
        const at = text.indexOf('|');
        const document = fakeDocument(text.replace('|', ''), { uri: vscode.Uri.file(path.join(site, 'admin', 'users.asp')) });
        const list = await new HtmlAttributePathCompletionProvider().provideCompletionItems(document, document.positionAt(at));
        return list.items.map(item => String(item.label)).sort();
    };

    it("offers the page's folder, and the site root after a /", async () => {
        assert.deepStrictEqual(await offered('<a href="|">x</a>'), ['edit.asp']);
        assert.deepStrictEqual(await offered('<img src="/images/|">'), ['logo.gif']);
        assert.deepStrictEqual(await offered("<form action='|'>"), ['edit.asp']);
    });

    it('offers nothing in an href VBScript or JavaScript writes, or in a URL', async () => {
        assert.deepStrictEqual(await offered('<% Response.Write "<a href=""|" %>'), []);
        assert.deepStrictEqual(await offered('<script>var s = \'<a href="|\';</script>'), []);
        assert.deepStrictEqual(await offered('<a href="http://example.com/|">x</a>'), []);
        assert.deepStrictEqual(await offered('<a class="|">x</a>'), []);
    });
});
