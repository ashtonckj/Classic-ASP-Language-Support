/**
 * ignoreActions.ts  (platform/)
 *
 * The quick fixes "Ignore on this line" and "Ignore in this file" for any of
 * this extension's problems. They write the asp-ignore comment that
 * core/ignoreComments.ts reads, in whatever comment the place allows: a
 * VBScript `'` inside `<% %>`, `//` in a script, `/* *\/` in a style, and
 * `<!-- -->` in the markup.
 */

import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from './diagnostics';
import { textOf, zonesFor } from './documentState';
import { findIgnoreDirectives } from '../core/ignoreComments';
import { endsWithContinuation } from '../core/vbLexical';
import { pageLanguage } from '../vbscript/pageSegments';

type Ranges = ReadonlyArray<{ start: number; end: number }>;
const inside = (ranges: Ranges, at: number, open = 0, close = 0) =>
    ranges.some(r => r.start + open <= at && at <= r.end - close);

/** The comment that silences `codes` on the next line, as a line to put at `at` (a line start). */
function nextLineComment(document: vscode.TextDocument, at: number, codes: string): string | undefined {
    const text = textOf(document);
    const zones = zonesFor(document);
    const jscript = pageLanguage(text) === 'jscript';

    // Server code: only strictly inside a <% %> block, never in front of its <%.
    if (inside(zones.aspBlocks, at, 2, 2) || inside(zones.vbsScripts, at)) {
        // A comment line between two halves of a statement continued with _ would end it.
        const previous = document.lineAt(Math.max(0, document.positionAt(at).line - 1)).text;
        if (at > 0 && endsWithContinuation(previous)) { return undefined; }
        return jscript && inside(zones.aspBlocks, at, 2, 2) ? `// asp-ignore-next-line ${codes}` : `' asp-ignore-next-line ${codes}`;
    }
    if (inside(zones.jsBlocks, at)) { return `// asp-ignore-next-line ${codes}`; }
    if (inside(zones.cssBlocks, at)) { return `/* asp-ignore-next-line ${codes} */`; }

    // Markup, but not inside a tag that spans lines: a comment between its attributes breaks it.
    const lastOpen = text.lastIndexOf('<', at - 1);
    const lastClose = text.lastIndexOf('>', at - 1);
    if (lastOpen > lastClose && /[a-zA-Z]/.test(text[lastOpen + 1] ?? '')) { return undefined; }
    return `<!-- asp-ignore-next-line ${codes} -->`;
}

/** Where a page's file-wide comment goes: after a first-line `<%@ … %>`, which IIS wants first. */
function fileCommentAt(document: vscode.TextDocument): vscode.Position {
    const first = document.lineAt(0);
    if (!/^\s*<%@/.test(first.text)) { return new vscode.Position(0, 0); }
    return document.lineCount > 1 ? new vscode.Position(1, 0) : first.range.end;
}

export class IgnoreCodeActionProvider implements vscode.CodeActionProvider {
    static readonly kinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const directives = findIgnoreDirectives(textOf(document));
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== DIAGNOSTIC_SOURCE || diagnostic.code === undefined) { continue; }
            const code = String(typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code);
            const line = diagnostic.range.start.line;

            // ── On this line ───────────────────────────────────────────────
            const above = directives.find(d => d.kind === 'next-line' && d.line === line - 1);
            if (above && above.codes.length > 0) {
                actions.push(this.action(`Ignore '${code}' on this line`, diagnostic, edit =>
                    edit.insert(document.uri, document.positionAt(above.codesEnd), `, ${code}`)));
            } else if (!above) {
                const lineStart = document.offsetAt(new vscode.Position(line, 0));
                const comment = nextLineComment(document, lineStart, code);
                if (comment) {
                    const indent = /^[ \t]*/.exec(document.lineAt(line).text)![0];
                    actions.push(this.action(`Ignore '${code}' on this line`, diagnostic, edit =>
                        edit.insert(document.uri, new vscode.Position(line, 0), indent + comment + eol)));
                }
            }

            // ── In this file ───────────────────────────────────────────────
            const fileWide = directives.find(d => d.kind === 'file');
            if (fileWide && fileWide.codes.length === 0) { continue; }   // already every code
            actions.push(this.action(`Ignore '${code}' in this file`, diagnostic, edit => {
                if (fileWide) {
                    edit.insert(document.uri, document.positionAt(fileWide.codesEnd), `, ${code}`);
                    return;
                }
                // In front of the first line rather than on a line of its own: a
                // new line there would be sent to the browser ahead of the page,
                // and an XML page must start with its <?xml.
                const comment = pageLanguage(textOf(document)) === 'jscript' ? '//' : "'";
                edit.insert(document.uri, fileCommentAt(document),
                    `<% ${comment} asp-ignore-file ${code} %>`);
            }));
        }
        return actions;
    }

    private action(title: string, diagnostic: vscode.Diagnostic, build: (edit: vscode.WorkspaceEdit) => void): vscode.CodeAction {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.edit = new vscode.WorkspaceEdit();
        build(action.edit);
        return action;
    }
}
