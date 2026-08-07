import * as assert from 'assert';
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
