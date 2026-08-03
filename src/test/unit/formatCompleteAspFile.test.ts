import * as assert from 'assert';
import { formatCompleteAspFile } from '../../formatter/htmlFormatter';

// F4 — void-element closing tags (</br>, </input>, …) that Prettier rejects are
// stripped from the HTML, but that strip must NOT reach into VBScript strings or
// ASP blocks (it used to run on the raw file and delete `</br>` from strings —
// silent data loss). It now runs after ASP/JS masking.
describe('formatCompleteAspFile — void-tag strip stays out of strings (F4)', () => {
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
describe('formatCompleteAspFile — $ sequences in strings survive restore (Bug C)', () => {
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
describe('formatCompleteAspFile — ASP inside <script> keeps JS order (Bug E)', () => {
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
