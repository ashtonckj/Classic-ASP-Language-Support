import * as assert from 'assert';
import * as vscode from 'vscode';
import { findIgnoreDirectives, ignoreDirectives, isIgnored } from '../../core/ignoreComments';
import { IgnoreCodeActionProvider } from '../../platform/ignoreActions';
import { DIAGNOSTIC_SOURCE, makeDiagnostic } from '../../platform/diagnostics';
import { fakeDocument } from './_helpers';

// A problem can be silenced with a comment in the page — no setting: the
// comment goes wherever the page goes, so everyone who opens it sees the same.

describe('asp-ignore comments — what they silence', () => {
    it('silences the next line, in every comment style, for the codes listed', () => {
        const page = [
            '<%',
            "' asp-ignore-next-line missing-set, undeclared",
            'x = 1',
            'Rem asp-ignore-next-line',
            'y = 2',
            '%>',
            '<!-- asp-ignore-next-line html-tag -->',
            '<div>',
            '<script>',
            '// asp-ignore-next-line 2339',
            'a.toFixed(2).push(3);',
            '</script>',
            '<style>',
            '/* asp-ignore-next-line css-unknown-properties */',
            'p { colr: red; }',
            '</style>',
        ].join('\n');
        const directives = ignoreDirectives(page);
        assert.ok(isIgnored(directives, 2, 'missing-set'));
        assert.ok(isIgnored(directives, 2, 'UNDECLARED'), 'codes are matched without regard to case');
        assert.ok(!isIgnored(directives, 2, 'vbscript-block'), 'only the codes listed');
        assert.ok(isIgnored(directives, 4, 'anything'), 'no codes: every code');
        assert.ok(!isIgnored(directives, 5, 'anything'), 'the next line only');
        assert.ok(isIgnored(directives, 7, 'html-tag'));
        assert.ok(isIgnored(directives, 10, 2339), 'JavaScript codes are numbers');
        assert.ok(isIgnored(directives, 14, 'css-unknown-properties'));
    });

    it('silences the whole page with asp-ignore-file', () => {
        const directives = ignoreDirectives("<% ' asp-ignore-file missing-include %>\n<p>\n\n<!--#include file=\"x.inc\"-->");
        assert.ok(isIgnored(directives, 3, 'missing-include'));
        assert.ok(!isIgnored(directives, 3, 'html-tag'));
        assert.ok(isIgnored(ignoreDirectives('<% \' asp-ignore-file %>'), 40, 'html-tag'));
    });

    it('reads a code list up to the end of its comment', () => {
        const [directive] = findIgnoreDirectives('<!-- asp-ignore-file html-tag asp-tag -->');
        assert.deepStrictEqual(directive.codes, ['html-tag', 'asp-tag']);
        assert.strictEqual('<!-- asp-ignore-file html-tag asp-tag -->'.slice(0, directive.codesEnd), '<!-- asp-ignore-file html-tag asp-tag');
    });
});

describe('IgnoreCodeActionProvider — the quick fixes write the comment', () => {
    const provider = new IgnoreCodeActionProvider();

    /** The text of each action's single edit, by title. */
    function actionsFor(page: string, line: number, code: string | number): Record<string, string> {
        const document = fakeDocument(page) as unknown as vscode.TextDocument;
        const range = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 1));
        const diagnostic = makeDiagnostic(range, 'x', vscode.DiagnosticSeverity.Warning, code as never);
        const actions = provider.provideCodeActions(document, range, { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext);
        return Object.fromEntries(actions.map(a => {
            const [edit] = a.edit!.get(document.uri);
            return [a.title, `${edit.range.start.line}:${edit.range.start.character}:${edit.newText}`];
        }));
    }

    it('uses a VBScript comment inside <% %>, kept at the line\'s indent', () => {
        const actions = actionsFor('<%\n  Set x = 1\n%>', 1, 'missing-set');
        assert.strictEqual(actions["Ignore 'missing-set' on this line"], "1:0:  ' asp-ignore-next-line missing-set\n");
        assert.strictEqual(actions["Ignore 'missing-set' in this file"], "0:0:<% ' asp-ignore-file missing-set %>");
    });

    it('uses the comment of the markup, a script or a style', () => {
        assert.strictEqual(actionsFor('<p>\n<div>\n</p>', 1, 'html-tag')["Ignore 'html-tag' on this line"],
            '1:0:<!-- asp-ignore-next-line html-tag -->\n');
        assert.strictEqual(actionsFor('<script>\nvar a = 1;\n</script>', 1, 2339)["Ignore '2339' on this line"],
            '1:0:// asp-ignore-next-line 2339\n');
        assert.strictEqual(actionsFor('<style>\np { colr: red }\n</style>', 1, 'css-x')["Ignore 'css-x' on this line"],
            '1:0:/* asp-ignore-next-line css-x */\n');
    });

    it('adds to a comment that is already there', () => {
        const actions = actionsFor("<% ' asp-ignore-file html-tag %>\n<%\n' asp-ignore-next-line undeclared\nx = 1\n%>", 3, 'missing-set');
        assert.strictEqual(actions["Ignore 'missing-set' on this line"], '2:33:, missing-set');
        assert.strictEqual(actions["Ignore 'missing-set' in this file"], '0:29:, missing-set');
    });

    it('puts the file comment after a first-line <%@ %>, and offers no line comment where one would break the code', () => {
        const actions = actionsFor('<%@ Language="VBScript" %>\n<%\nx = 1 & _\n  y\n%>', 3, 'undeclared');
        assert.strictEqual(actions["Ignore 'undeclared' in this file"], "1:0:<% ' asp-ignore-file undeclared %>");
        assert.strictEqual(actions["Ignore 'undeclared' on this line"], undefined, 'not between two halves of a statement');

        const inTag = actionsFor('<div\n  class="a"\n>', 1, 'html-tag');
        assert.strictEqual(inTag["Ignore 'html-tag' on this line"], undefined, 'not between a tag\'s attributes');
    });

    it('offers nothing for a problem that is not this extension\'s', () => {
        const document = fakeDocument('<% x %>') as unknown as vscode.TextDocument;
        const diagnostic = new vscode.Diagnostic(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)), 'x');
        diagnostic.source = 'eslint';
        assert.deepStrictEqual(provider.provideCodeActions(document, diagnostic.range, { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext), []);
        assert.strictEqual(DIAGNOSTIC_SOURCE, 'Classic ASP');
    });
});
