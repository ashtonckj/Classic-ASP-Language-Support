import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatCompleteAspFile } from '../../formatter/htmlFormatter';

// A generated corpus, run through the formatter on every build.
//
// The formatter's bugs have almost all been of a kind that one hand-written
// example does not catch: they appear for a particular ASP block inside a
// particular element with a particular thing before it, and the example someone
// happens to write is rarely that combination. Four of the six bugs fixed in the
// round that produced this file were found by sweeping combinations rather than
// by a report — the blank line after an expanded block, the two-pass settle for
// a block nested in HTML, the empty `<% %>`, and the blank line between two
// adjacent blocks, which only appears when a block follows another with nothing
// between them.
//
// Four properties are checked, and each has caught a real defect:
//
//   * it settles in ONE pass. `format(format(x)) === format(x)`. A formatter
//     that does not converge is losing, duplicating or re-deciding something,
//     and it is the cheapest bug detector this codebase has.
//   * it adds no blank line. Not "has none" — a page may have blank lines the
//     author put there, and collapsing a run of them is deliberate. What must
//     never happen is the count going UP, which is the symptom every blank-line
//     bug so far has shown: two pieces of code both adding a newline.
//   * the ASP survives. Every non-whitespace character inside `<% … %>` must
//     still be there afterwards — the one property that catches losing code
//     rather than merely mis-indenting it.
//   * it does not throw.
//
// Both htmlIndentMode values are swept, because they take different paths
// through the indent logic and a bug has already hidden in one of them.

const WRAPPERS = [
    '|',
    '<div>|</div>',
    '<p>|</p>',
    '<span>|</span>',
    '<li>|</li>',
    '<td>|</td>',
    '<table><tr><td>|</td></tr></table>',
    '<div><div>|</div></div>',
    '<form action="/x">|</form>',
    '<select>|</select>',
    '<h1>|</h1>',
    '<a href="/y">|</a>',
    '<button type="submit">|</button>',
    '<label>|</label>',
    '<ul><li>|</li></ul>',
    '<table><thead><tr><th>|</th></tr></thead></table>',
    '<blockquote>|</blockquote>',
    '<b>|</b>',
];

const BLOCKS = [
    '<% If a Then %>y<% End If %>',
    '<% If a Then %>y<% Else %>n<% End If %>',
    // Two blocks with nothing between them — the shape that produced a blank line.
    '<% If a Then %><% If b Then %>y<% End If %><% End If %>',
    '<% For i = 1 To 3 %><%= i %><% Next %>',
    '<% For Each k In d %><%= k %><% Next %>',
    '<% Do While x %>y<% Loop %>',
    '<% While x %>y<% Wend %>',
    '<% Select Case x %><% Case 1 %>one<% Case Else %>other<% End Select %>',
    '<%= name %>',
    '<%= Server.HTMLEncode(name) %>',
    '<%= Replace(s, "a", "b") %>',
    'text <%= name %> more',
    '<% %>',
    '<% x = 1 %>',
    "<% ' a comment %>",
    '<% Response.Write "hi" %>',
    // A continuation that also closes the block.
    '<% s = "a" & _\n   "b" %>',
];

/** What comes before the block inside its wrapper. */
const LEADS = ['', 'before ', '<b>b</b>', '&nbsp;'];

/**
 * Every non-whitespace character inside the page's ASP blocks, lowercased.
 *
 * Whitespace and case are what the formatter is FOR — it re-indents, and it
 * rewrites `dim` as `Dim`. Everything else about the code has to come through
 * untouched, and comparing this before and after is what would catch a block
 * being dropped, duplicated or truncated.
 */
function aspSignature(source: string): string {
    return (source.match(/<%[\s\S]*?%>/g) ?? []).join('').replace(/\s+/g, '').toLowerCase();
}

/**
 * How many blank lines the text contains.
 *
 * The final newline is dropped first. Splitting `"a\n"` yields a trailing empty
 * string that is not a blank line, and a page that did not end with a newline
 * gains one when it is formatted — which is correct, and would otherwise be
 * reported as a blank line appearing out of nowhere.
 */
function blankLines(source: string): number {
    return source.replace(/\n$/, '').split('\n').filter(line => line.trim().length === 0).length;
}

function combinations(): string[] {
    const pages: string[] = [];
    for (const wrapper of WRAPPERS) {
        for (const block of BLOCKS) {
            for (const lead of LEADS) {
                pages.push(wrapper.replace('|', lead + block) + '\n');
            }
        }
    }
    return pages;
}

/** Runs the four checks over one page, returning a reason when it fails. */
async function check(page: string): Promise<string | undefined> {
    let once: string;
    try {
        once = await formatCompleteAspFile(page);
    } catch (error) {
        return `threw: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }

    let twice: string;
    try {
        twice = await formatCompleteAspFile(once);
    } catch (error) {
        return `threw on the second format: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }

    if (twice !== once) {
        return `did not settle in one pass\n    first:  ${JSON.stringify(once)}\n    second: ${JSON.stringify(twice)}`;
    }
    // A generated page has none to begin with, so for those this is "has none".
    const before = blankLines(page);
    const after  = blankLines(once);
    if (after > before) {
        return `added ${after - before} blank line(s) (${before} → ${after})\n    got: ${JSON.stringify(once)}`;
    }
    if (aspSignature(once) !== aspSignature(page)) {
        return `changed the ASP\n    was: ${aspSignature(page)}\n    now: ${aspSignature(once)}`;
    }
    return undefined;
}

/** Reports every failure rather than only the first, so one run shows the shape of the problem. */
function report(failures: Array<[string, string]>, total: number): void {
    if (failures.length === 0) { return; }
    const shown = failures.slice(0, 10)
        .map(([page, reason]) => `  ${JSON.stringify(page)}\n    ${reason}`)
        .join('\n');
    const more = failures.length > 10 ? `\n  …and ${failures.length - 10} more` : '';
    assert.fail(`${failures.length} of ${total} pages failed:\n${shown}${more}`);
}

describe('formatter sweep — generated combinations', () => {

    const realGetConfiguration = vscode.workspace.getConfiguration;
    const overrides: Record<string, unknown> = {};

    before(() => {
        (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
            get: (key: string, defaultValue?: unknown) =>
                (key in overrides ? overrides[key] : defaultValue),
        });
    });

    after(() => {
        (vscode.workspace as { getConfiguration: unknown }).getConfiguration = realGetConfiguration;
    });

    for (const mode of ['continuation', 'flat']) {
        it(`formats every combination cleanly with htmlIndentMode=${mode}`, async function () {
            this.timeout(120_000);
            overrides.htmlIndentMode = mode;

            const pages    = combinations();
            const failures: Array<[string, string]> = [];
            for (const page of pages) {
                const reason = await check(page);
                if (reason) { failures.push([page, reason]); }
            }
            report(failures, pages.length);
        });
    }
});

describe('formatter sweep — the pages in test-files/', () => {

    // The fixtures are whole pages rather than snippets, so they exercise the
    // interaction between blocks that the generated matrix cannot: include
    // directives, <%@ %>, <script> and <style> bodies, real tables.
    it('formats every fixture page cleanly', async function () {
        this.timeout(120_000);

        const root  = path.join(__dirname, '..', '..', '..', 'test-files');
        const pages: string[] = [];
        (function walk(dir: string): void {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory())              { walk(full); }
                else if (/\.(asp|inc)$/i.test(entry.name)) { pages.push(full); }
            }
        })(root);

        assert.ok(pages.length > 0, `no fixture pages found under ${root}`);

        const failures: Array<[string, string]> = [];
        for (const file of pages) {
            const reason = await check(fs.readFileSync(file, 'utf8'));
            if (reason) { failures.push([path.relative(root, file), reason]); }
        }
        report(failures, pages.length);
    });
});
