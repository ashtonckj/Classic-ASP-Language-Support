import * as assert from 'assert';
import * as vscode from 'vscode';
import { formatCompleteAspFile, insertImpliedTableEndTags } from '../../formatter/htmlFormatter';

// Classic ASP tables routinely omit the optional </td> </tr> … end tags. Prettier
// does not apply the implied-end-tag rules, so these must be inserted before it or
// a following <tr> gets nested inside the still-open <td>.
describe('insertImpliedTableEndTags', () => {
    it('inserts implied </td> and </tr> for an omitted-end-tag table', () => {
        const out = insertImpliedTableEndTags('<table><tr><td>a<td>b<tr><td>c<td>d</table>');
        assert.strictEqual(out, '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
    });

    it('leaves a fully-closed table unchanged', () => {
        const wellFormed = '<table><tr><td>a</td><td>b</td></tr></table>';
        assert.strictEqual(insertImpliedTableEndTags(wellFormed), wellFormed);
    });

    it('scopes cell/row closing to the nearest table (nested tables)', () => {
        const out = insertImpliedTableEndTags('<table><tr><td><table><tr><td>inner</table><td>after</table>');
        assert.strictEqual(
            out,
            '<table><tr><td><table><tr><td>inner</td></tr></table></td><td>after</td></tr></table>',
        );
    });

    it('handles omitted thead/tbody/th end tags', () => {
        const out = insertImpliedTableEndTags('<table><thead><tr><th>H<tbody><tr><td>x</table>');
        assert.strictEqual(
            out,
            '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>',
        );
    });

    it('does not treat content elements inside a cell as table transitions', () => {
        const out = insertImpliedTableEndTags('<table><tr><td><div>x</div><td>y</table>');
        assert.strictEqual(out, '<table><tr><td><div>x</div></td><td>y</td></tr></table>');
    });
});

describe('formatCompleteAspFile — table with omitted end tags', () => {
    it('formats a table into correct rows instead of nesting them', async () => {
        const input = '<table>\n<tr>\n<td>apple\n<td>banana\n<tr>\n<td>cherry\n<td>date\n</table>';
        const out = await formatCompleteAspFile(input);

        assert.strictEqual((out.match(/<tr>/gi) ?? []).length, 2, 'two rows');
        assert.strictEqual((out.match(/<td>/gi) ?? []).length, 4, 'four cells');

        // Row 1 must close before row 2 opens — i.e. the rows are siblings, not
        // nested. (When Prettier mis-nested, the first </tr> came AFTER the 2nd <tr>.)
        const rowOpens  = [...out.matchAll(/<tr>/gi)].map(m => m.index ?? -1);
        const firstClose = out.search(/<\/tr>/i);
        assert.ok(firstClose < rowOpens[1], `row 1 must close before row 2 opens; got:\n${out}`);
    });
});

// Void-element closing tags (</br>, </input>, …) that Prettier rejects are
// stripped from the HTML, but that strip must NOT reach into VBScript strings or
// ASP blocks (it used to run on the raw file and delete `</br>` from strings —
// silent data loss). It now runs after ASP/JS masking.
describe('formatCompleteAspFile — void-tag strip stays out of strings', () => {
    it('preserves a void closing tag emitted from a VBScript string', async () => {
        const input = '<%\nResponse.Write "</br>"\n%>';
        const out = await formatCompleteAspFile(input);
        assert.ok(
            out.includes('</br>'),
            `</br> inside a VBScript string must be preserved; got ${JSON.stringify(out)}`,
        );
    });

    it('still removes a real HTML void closing tag', async () => {
        const input = '<div></div>\n</br>\n<p>x</p>';
        const out = await formatCompleteAspFile(input);
        assert.ok(!/<\/br>/i.test(out), `a real </br> element should be removed; got ${JSON.stringify(out)}`);
    });
});

// Restore must insert the formatted VBScript literally. `$&`, `$$` etc.
// are special in String.replace replacement strings; using them there silently
// corrupted VBScript strings (`$&` → placeholder text, `$$` → `$`).
describe('formatCompleteAspFile — $ sequences in strings survive restore', () => {
    it('preserves $$ and $& in an inline <%= %> expression', async () => {
        const out = await formatCompleteAspFile('<table><tr><td><%= "a $$ b $& c" %></td></tr></table>');
        assert.ok(out.includes('$$'), `"$$" must survive; got ${JSON.stringify(out)}`);
        assert.ok(out.includes('$&'), `"$&" must survive; got ${JSON.stringify(out)}`);
    });

    it('preserves $$ and $& in a <% %> statement block', async () => {
        const out = await formatCompleteAspFile('<%\nResponse.Write "x $$ y $& z"\n%>');
        assert.ok(out.includes('$$') && out.includes('$&'),
            `dollar sequences must survive; got ${JSON.stringify(out)}`);
    });
});

// An ASP block inside <script>/<style> is masked with a JS/CSS-safe
// identifier (not an HTML comment), so Prettier can't parse it as a comment and
// reorder the surrounding code.
describe('formatCompleteAspFile — ASP inside <script> keeps JS order', () => {
    it('does not reorder statements around a <%= %> in <script>', async () => {
        const input = '<div>\n<script>\nvar x = <%= "userId" %>;\nalert(x);\n</script>\n</div>';
        const out   = await formatCompleteAspFile(input);

        const iAssign = out.indexOf('var x =');
        const iExpr   = out.indexOf('<%= "userId" %>');
        const iAlert  = out.indexOf('alert(x)');

        assert.ok(iAssign !== -1 && iExpr !== -1 && iAlert !== -1,
            `all three fragments must be present; got ${JSON.stringify(out)}`);
        assert.ok(iAssign < iExpr && iExpr < iAlert,
            `<%= %> must stay between "var x =" and alert(x); got ${JSON.stringify(out)}`);
        assert.ok(!/var x = alert\(x\)/.test(out),
            `assignment must not merge with alert(x); got ${JSON.stringify(out)}`);
    });
});

// The directive on line 1 of nearly every Classic ASP page must survive a full
// Format Document pass intact — a split `<%@` is a compile error in IIS.
describe('formatCompleteAspFile — processing directive', () => {
    it('leaves the leading <%@ ... %> directive on its own single line', async () => {
        const input = '<%@ Language="VBScript" %>\n<html>\n<body>\n<p>hi</p>\n</body>\n</html>\n';
        const out   = await formatCompleteAspFile(input);

        assert.strictEqual(
            out.split('\n')[0],
            '<%@ Language="VBScript" %>',
            `directive must stay intact; got:\n${out}`,
        );
    });
});

// `<%= … %>` is Response.Write in expression form, so its output is part of the
// text around it. It used to be masked as an HTML comment before Prettier ran,
// and Prettier treats a comment as a node that cannot share a line with prose:
// it broke the line around it and then moved the enclosing tag's `>` down to
// keep the rendered whitespace unchanged, giving
//
//     <span class="info-value"
//       ><%= txtbadge %>
//       &mdash;
//       <%= empName %></span
//     >
//
// The comment was also twice as long as the expression it stood for, so
// Prettier measured a line that fitted as one that did not and broke it for no
// reason. A word placeholder padded to the block's own width fixes both, and is
// the same technique prettier-plugin-jinja-template and
// prettier-plugin-go-template use for `{{ … }}`.
describe('formatCompleteAspFile — <%= %> is laid out as page text', () => {

    it('keeps an expression on the line of the text it belongs to', async () => {
        const out = await formatCompleteAspFile('<p>Hello <%= name %>, welcome.</p>\n');
        assert.strictEqual(out, '<p>Hello <%= name %>, welcome.</p>\n');
    });

    it('does not split a span around its expressions', async () => {
        const source = '<span class="v"><%= a %> &mdash; <%= b %></span>\n';
        assert.strictEqual(await formatCompleteAspFile(source), source);
    });

    it('never moves a closing tag onto its own line', async () => {
        const out = await formatCompleteAspFile(
            '<div class="info-row">\n<span class="info-label">Employee #</span>\n'
            + '<span class="info-value"><%= txtbadge %> &mdash; <%= empName %></span>\n</div>\n');
        assert.ok(!/<\/\w+\s*\n\s*>/.test(out), `a closing tag was split across lines:\n${out}`);
        assert.ok(!/\n\s*><%/.test(out),        `an opening tag's > was pushed down:\n${out}`);
        assert.ok(
            out.includes('<span class="info-value"><%= txtbadge %> &mdash; <%= empName %></span>'),
            `the span should be on one line; got:\n${out}`,
        );
    });

    // A page formatted by the older version is full of the broken shape, so the
    // fix has to pull it back together rather than leave it alone.
    it('reflows a page the previous placeholder had already broken apart', async () => {
        const broken = [
            '<div class="info-row">',
            '    <span class="info-label">Employee #</span>',
            '    <span class="info-value">',
            '         <%= txtbadge %>',
            '        &mdash;',
            '        <%= empName %></span>',
            '</div>',
            '',
        ].join('\n');
        const out = await formatCompleteAspFile(broken);
        assert.ok(
            /<span class="info-value">\s?<%= txtbadge %> &mdash; <%= empName %><\/span>/.test(out),
            `the expressions should be pulled back onto one line; got:\n${out}`,
        );
    });

    // The placeholder is padded to the width of the block it replaces, so a line
    // that fits inside printWidth is not broken on account of the mask.
    it('measures a line by the expression, not by the placeholder', async () => {
        // 74 characters as written — comfortably inside the default 80 — but the
        // old placeholder pushed it past the limit and forced a wrap.
        const source = '<p>Order <%= ordNo %> for <%= custName %> shipped on <%= shipDate %>.</p>\n';
        assert.ok(source.length - 1 < 80, 'the fixture must fit inside printWidth');
        assert.strictEqual(await formatCompleteAspFile(source), source);
    });

    it('still wraps genuinely long text, keeping the expression inline', async () => {
        const out = await formatCompleteAspFile(
            '<p>This is a fairly long paragraph of text that will certainly exceed '
            + 'the print width <%= n %> and wrap.</p>\n');
        assert.ok(out.includes('width <%= n %> and wrap.'), `the expression should stay in the prose; got:\n${out}`);
        assert.ok(out.split('\n').every(l => l.length <= 80), `a line exceeded printWidth:\n${out}`);
    });

    it('leaves an expression inside an attribute value alone', async () => {
        const source = '<a href="/x?id=<%= id %>">link</a>\n';
        assert.strictEqual(await formatCompleteAspFile(source), source);
    });

    it('leaves a statement block on its own line', async () => {
        // Only expressions become text placeholders; a statement block still
        // structures the page and keeps the comment placeholder.
        const out = await formatCompleteAspFile('<ul>\n<% For i = 1 To 3 %>\n<li><%= i %></li>\n<% Next %>\n</ul>\n');
        assert.ok(/<li><%= i %><\/li>/.test(out), `the list item should be intact; got:\n${out}`);
        assert.ok(/\n\s*<%\n/.test(out),          `the For block should stand on its own lines; got:\n${out}`);
    });
});

// Converting an inline `<% … %>` block onto its own lines appended a newline
// plus the base indent unconditionally. When the placeholder had already ended
// its line, that line's own newline was still there, so the two together left a
// blank line: permanent in the middle of a file, and stripped by the NEXT
// format at end of file, so such a file never converged.
describe('formatCompleteAspFile — expanding an inline block adds no blank line', () => {

    it('leaves no blank line at end of file, and settles in one pass', async () => {
        const out = await formatCompleteAspFile('<% If a Then %>yes<% End If %>\n');
        assert.ok(!/\n[ \t]*\n/.test(out), `a blank line was inserted:\n${JSON.stringify(out)}`);
        assert.strictEqual(await formatCompleteAspFile(out), out, 'the result should be stable');
    });

    it('leaves no blank line in the middle of a file', async () => {
        const out = await formatCompleteAspFile('<p>a</p>\n<% If a Then %>yes<% End If %>\n<p>b</p>\n');
        assert.ok(!/\n[ \t]*\n/.test(out), `a blank line was inserted:\n${JSON.stringify(out)}`);
        assert.ok(out.includes('<p>b</p>'), `the following markup should survive:\n${out}`);
        assert.strictEqual(await formatCompleteAspFile(out), out, 'the result should be stable');
    });

    // The newline after the block is still needed when the block did NOT end its
    // line — otherwise whatever followed would be swallowed onto the %> line.
    it('still breaks the line when content follows the block', async () => {
        const out = await formatCompleteAspFile('<p>a</p>\n<% If a Then %>yes<% End If %> tail\n<p>b</p>\n');
        assert.ok(/%>\ntail/.test(out), `trailing content should start a new line; got:\n${out}`);
        assert.ok(!/\n[ \t]*\n/.test(out), `a blank line was inserted:\n${JSON.stringify(out)}`);
    });

    // Found by sweeping a corpus rather than by one report — 10 of 18 inline
    // block shapes were affected, so the property is worth asserting broadly.
    it('adds no blank line for any inline block shape', async () => {
        const shapes = [
            '<% If a Then %>yes<% End If %>\n',
            '<p><% If a Then %>yes<% End If %></p>\n',
            '<div><% For i = 1 To 3 %>x<% Next %></div>\n',
            '<% Do While x %>y<% Loop %>\n',
            '<span>a<% If b Then %>c<% End If %></span>\n',
            '<p>before</p>\n<% Select Case x %><% Case 1 %>one<% End Select %>\n<p>after</p>\n',
        ];
        for (const shape of shapes) {
            const out = await formatCompleteAspFile(shape);
            assert.ok(
                !/\n[ \t]*\n/.test(out),
                `a blank line was inserted for ${JSON.stringify(shape)}:\n${JSON.stringify(out)}`,
            );
        }
    });
});

// A statement block Prettier left inline — `<td><!--ID-->y</td>` — is moved onto
// lines of its own during the restore. Its indent was read from the whitespace
// immediately BEFORE the placeholder, which is empty in exactly that case, so
// the block landed at column 0 and only reached its real column on a second
// format, once the page already had it standalone. td, div, p and span all took
// two passes.
//
// The layout is now settled before the indent is read: the placeholder is split
// onto its own line and Prettier is asked again, so one pass produces what two
// used to. The indentation is Prettier's either way.
describe('formatCompleteAspFile — a block nested in HTML settles in one pass', () => {

    const settlesInOnePass = async (source: string) => {
        const once  = await formatCompleteAspFile(source);
        const twice = await formatCompleteAspFile(once);
        assert.strictEqual(twice, once, `a second format changed the file:\n${once}\n--- became ---\n${twice}`);
        return once;
    };

    it('puts the tags at the cell indent, not at column 0', async () => {
        const out = await settlesInOnePass(
            '<table><tr><td><% If a Then %>y<% End If %></td></tr></table>\n');
        assert.ok(!/^<%/m.test(out), `a tag was left at column 0:\n${out}`);
        // <td> sits at column 4, so its content — including the tags — is at 6.
        for (const line of out.split('\n').filter(l => /<%|%>/.test(l))) {
            assert.strictEqual(
                line.match(/^[ \t]*/)![0].length, 6,
                `expected the tags at the cell's content indent; got:\n${out}`,
            );
        }
    });

    it('settles for every kind of enclosing element', async () => {
        for (const source of [
            '<table><tr><td><% If a Then %>y<% End If %></td></tr></table>\n',
            '<div><% If a Then %>y<% End If %></div>\n',
            '<p><% If a Then %>y<% End If %></p>\n',
            '<span>a<% If b Then %>c<% End If %></span>\n',
            '<ul><li><% For i = 1 To 3 %>x<% Next %></li></ul>\n',
        ]) {
            await settlesInOnePass(source);
        }
    });

    it('settles for an empty block', async () => {
        await settlesInOnePass('<p><% %></p>\n');
    });

    it('settles a block nested several elements deep', async () => {
        const out = await settlesInOnePass(
            '<div><table><tr><td><div><% If a Then %>deep<% End If %></div></td></tr></table></div>\n');
        assert.ok(out.includes('deep'), `the content should survive:\n${out}`);
    });

    // The re-layout must not undo the two fixes before it.
    it('still adds no blank line and keeps expressions inline', async () => {
        const out = await settlesInOnePass(
            '<td><% If a Then %><span><%= name %> here</span><% End If %></td>\n');
        assert.ok(!/\n[ \t]*\n/.test(out), `a blank line was inserted:\n${JSON.stringify(out)}`);
        assert.ok(/<span><%= name %> here<\/span>/.test(out), `the expression should stay inline:\n${out}`);
    });
});

// An ASP block inside an HTML tag — between two attributes, or inside an
// attribute value — has nowhere to put a line break. Only raw-text blocks
// (inside <script>/<style>) were kept on one line, so a statement between
// attributes was expanded and the tag torn apart around it:
//
//     <input
//       type="text" <%
//     If sel Then
//     %>
//       checked <%
//
// The placeholders for those two kinds were also far longer than the ASP they
// stood for — `ASPINLINE_<id>_END` is 37 characters for a 9-character
// `<%= id %>` — so Prettier measured lines as twice their width and broke tags
// that would have fitted.
describe('formatCompleteAspFile — ASP inside an HTML tag stays inside it', () => {

    it('keeps a statement between attributes on one line', async () => {
        const out = await formatCompleteAspFile(
            '<input type="text" <% If sel Then %>checked<% End If %> name="a">\n');
        assert.ok(!/^<%/m.test(out), `the VBScript was dedented out of the tag:\n${out}`);
        assert.ok(!/<%\n/.test(out), `the block was expanded inside a tag:\n${out}`);
        assert.ok(/<% If sel Then %>/.test(out) && /<% End If %>/.test(out),
            `the blocks should stay on one line each; got:\n${out}`);
    });

    it('keeps a statement inside an attribute value on one line', async () => {
        const out = await formatCompleteAspFile('<input value="<% If a Then %>x<% End If %>">\n');
        assert.ok(!/<%\n/.test(out), `the block was expanded inside an attribute:\n${out}`);
        assert.ok(/value="<% If a Then %>x<% End If %>"/.test(out),
            `the attribute value should be intact; got:\n${out}`);
    });

    it('does not break a tag that fits once the mask is the right size', async () => {
        // 43 characters. Its two inline placeholders used to measure 37 each,
        // so the masked line came to 99 and Prettier split the tag open.
        const source = '<a href="/p?id=<%= id %>&n=<%= n %>">go</a>\n';
        assert.ok(source.length - 1 < 80, 'the fixture must fit inside printWidth');
        assert.strictEqual(await formatCompleteAspFile(source), source);
    });

    it('keeps a conditional attribute on its element', async () => {
        const out = await formatCompleteAspFile('<td <% If hi Then %>class="hi"<% End If %>>cell</td>\n');
        assert.ok(/<td <% If hi Then %> class="hi" <% End If %>>/.test(out),
            `the tag should stay on one line; got:\n${out}`);
    });

    it('settles in one pass for every in-tag shape', async () => {
        for (const source of [
            '<input type="text" <% If sel Then %>checked<% End If %> name="a">\n',
            '<input <% If a Then %>checked<% End If %>>\n',
            '<input value="<% If a Then %>x<% End If %>">\n',
            '<a href="/p?id=<%= id %>&n=<%= n %>">go</a>\n',
            '<td <% If hi Then %>class="hi"<% End If %>>cell</td>\n',
            '<input <% If a Then %>checked<% End If %> <% If b Then %>disabled<% End If %>>\n',
        ]) {
            const once  = await formatCompleteAspFile(source);
            const twice = await formatCompleteAspFile(once);
            assert.strictEqual(twice, once, `a second format changed:\n${once}\n--- became ---\n${twice}`);
        }
    });
});

// Prettier formats an on* value as JavaScript, and once the attribute is too long
// for printWidth it moves the value onto a line of its own. The masked value was
// then never found again, and the page's event handler came back as the mask
// token itself — JSEVT4_mufcrirn — with the JavaScript gone.
describe('formatCompleteAspFile — an event handler survives being wrapped', () => {
    const depth = 30;
    const open  = '<div class="level">\n'.repeat(depth);
    const close = '</div>\n'.repeat(depth);
    const handler = "saveRecord('<%= recordId %>'); return false;";
    const page = open
        + '<button type="button" class="btn btn-primary" title="Save the record" onclick="' + handler + '">Save</button>\n'
        + close;

    it('keeps the handler, not the mask token', async () => {
        const out = await formatCompleteAspFile(page);
        assert.ok(!/JSEVT\d/.test(out), `a mask token was left behind:\n${out}`);
        assert.ok(out.includes('onclick="' + handler + '"'), `the handler must come back whole:\n${out}`);
    });

    it('settles in one pass', async () => {
        const once  = await formatCompleteAspFile(page);
        const twice = await formatCompleteAspFile(once);
        assert.strictEqual(twice, once);
    });
});

// A placeholder's number is part of its length, and Prettier lays a line out by
// its length. The numbers used to run on for the whole session, so a page
// formatted after enough others wrapped differently from the same page before.
describe('formatCompleteAspFile — the same page always formats the same', () => {
    it('gives the same result after a large page has been formatted', async function () {
        this.timeout(20000);
        const page = '<div>\n  <p>Order <%=x%> of <%=y%> shipped to <%=z%> on <%=d%> by courier <%=c%> ok</p>\n</div>\n';

        const before = await formatCompleteAspFile(page);
        await formatCompleteAspFile('<p>' + '<%=a%> '.repeat(10000) + '</p>\n');
        const after = await formatCompleteAspFile(page);

        assert.strictEqual(after, before);
    });
});

// The tidy-up for a <textarea> whose tags Prettier had broken ran on every
// element, so two links Prettier kept on separate lines were joined into one
// and the space the browser showed between them was lost.
describe('formatCompleteAspFile — elements on separate lines stay apart', () => {
    it('lays two links out as a .html file would', async () => {
        const out = await formatCompleteAspFile(
            '<div>\n<a href="edit.asp">Edit</a>\n<a href="delete.asp?confirm=yes&amp;return=list">Delete</a><span class="sep">|</span>\n</div>\n');
        assert.strictEqual(out,
            '<div>\n'
            + '  <a href="edit.asp">Edit</a>\n'
            + '  <a href="delete.asp?confirm=yes&amp;return=list">Delete</a\n'
            + '  ><span class="sep">|</span>\n'
            + '</div>\n');
    });
});

// With aspTagsOnSameLine a block after other content stays on that line, but
// the indent a line starts with was pasted in front of it, so two blocks on
// one line came out with a run of spaces between them — which the next format
// broke the line at.
describe('formatCompleteAspFile — aspTagsOnSameLine leaves a block where it is', () => {
    const realGetConfiguration = vscode.workspace.getConfiguration;

    before(() => {
        (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
            get: (key: string, defaultValue?: unknown) => (key === 'aspTagsOnSameLine' ? true : defaultValue),
        });
    });

    after(() => {
        (vscode.workspace as { getConfiguration: unknown }).getConfiguration = realGetConfiguration;
    });

    it('keeps two blocks on one line together, and settles', async () => {
        const once = await formatCompleteAspFile(
            '<div>\n<% Select Case mode %><% Case 1 %>\n<p>one</p>\n<% End Select %>\n</div>\n');
        assert.ok(once.includes('\n  <% Select Case mode %><% Case 1 %>\n'), `got:\n${once}`);
        assert.strictEqual(await formatCompleteAspFile(once), once);
    });
});

// Each branch of an If opening its own copy of a wrapper is valid ASP, but
// read top to bottom it is two <div>s and one </div>: Prettier nested the
// second inside the first and added a </div> of its own. The tags only one
// branch runs are hidden from Prettier and put back afterwards.
describe('formatCompleteAspFile — a tag each branch of an If opens', () => {
    const settlesInOnePass = async (source: string) => {
        const once  = await formatCompleteAspFile(source);
        const twice = await formatCompleteAspFile(once);
        assert.strictEqual(twice, once, `a second format changed the file:\n${once}\n--- became ---\n${twice}`);
        return once;
    };
    const count = (text: string, tag: string) => text.split(tag).length - 1;

    it('keeps the one </div>, with each branch\'s <div> at the same indent', async () => {
        const out = await settlesInOnePass(
            '<% If isAdmin Then %>\n<div class="admin">\n<% Else %>\n<div class="user">\n<% End If %>\n<p>content</p>\n</div>\n');
        assert.strictEqual(out,
            '<%\nIf isAdmin Then\n%>\n<div class="admin">\n<%\nElse\n%>\n<div class="user">\n<%\nEnd If\n%>\n'
            + '  <p>content</p>\n</div>\n');
    });

    it('keeps a closing tag in each branch', async () => {
        const source = '<div class="wrap">\n<p>x</p>\n<% If a Then %>\n</div>\n<% Else %>\n</div>\n<% End If %>\n';
        const out = await settlesInOnePass(source);
        assert.notStrictEqual(out, source, 'the page should have been formatted');
        assert.strictEqual(count(out, '</div>'), 2, out);
        assert.ok(out.includes('\n  <p>x</p>\n'), `the content should be indented inside the <div>:\n${out}`);
    });

    it('keeps each Case\'s <form> in a Select Case', async () => {
        const out = await settlesInOnePass(
            '<% Select Case mode %>\n<% Case 1 %>\n<form action="a.asp">\n<% Case Else %>\n<form action="b.asp">\n'
            + '<% End Select %>\n<input>\n</form>\n');
        assert.strictEqual(count(out, '<form'), 2, out);
        assert.strictEqual(count(out, '</form>'), 1, out);
        assert.ok(/^<form action="b\.asp">$/m.test(out), `the second <form> belongs at the first one's indent:\n${out}`);
    });

    it('keeps a closing tag whose opening tag Response.Write writes', async () => {
        const out = await settlesInOnePass('<% Response.Write "<table class=""grid"">" %>\n<tr><td>x</td></tr>\n</table>\n');
        assert.strictEqual(count(out, '</table>'), 1, out);
        assert.ok(out.includes('\n  <td>x</td>\n'), `the row should have been formatted:\n${out}`);
    });
});

// Each Prettier failure used to create a new "ASP Formatter Debug" channel, so
// the Output list gained another entry of the same name every time.
describe('the formatter debug channel', () => {
    it('is created once and reused when Prettier fails again', async () => {
        const window = vscode.window as unknown as { createOutputChannel: (name: string) => unknown };
        const original = window.createOutputChannel;
        let created = 0;
        window.createOutputChannel = name => { created++; return original(name); };
        try {
            const broken = '<div></span>\n';
            assert.strictEqual(await formatCompleteAspFile(broken), broken, 'a page Prettier cannot parse is left as it is');
            assert.strictEqual(await formatCompleteAspFile(broken), broken);
            assert.ok(created <= 1, `made ${created} channels`);
        } finally {
            window.createOutputChannel = original;
        }
    });
});
