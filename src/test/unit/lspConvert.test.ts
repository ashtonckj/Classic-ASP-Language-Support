import * as assert from 'assert';
import * as vscode from 'vscode';
import { fromLspCompletion, fromLspKind, fromLspMarkdown, fromLspRange } from '../../platform/lspConvert';

describe('lspConvert', () => {
    it('counts completion kinds from 0 where LSP counts from 1', () => {
        // LSP: Text 1, Property 10, Color 16, Snippet 15.
        assert.strictEqual(fromLspKind(1, vscode.CompletionItemKind.Value), vscode.CompletionItemKind.Text);
        assert.strictEqual(fromLspKind(15, vscode.CompletionItemKind.Value), vscode.CompletionItemKind.Snippet);
        assert.strictEqual(fromLspKind(undefined, vscode.CompletionItemKind.Value), vscode.CompletionItemKind.Value);
    });

    it("inserts the edit's text, as a snippet when the item says so", () => {
        const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } };
        const item = fromLspCompletion(
            { label: 'color', kind: 10, insertTextFormat: 2, textEdit: { newText: 'color: $0;', range } },
            { kind: vscode.CompletionItemKind.Property },
        );
        assert.strictEqual(item.label, 'color');
        assert.ok(item.insertText instanceof vscode.SnippetString);
        assert.strictEqual((item.insertText as vscode.SnippetString).value, 'color: $0;');
        assert.strictEqual(item.range, undefined, 'a range is taken only when asked for');
    });

    it('takes the range when asked, and plain text stays plain', () => {
        const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };
        const item = fromLspCompletion(
            { label: 'text', textEdit: { newText: '"text"', range } },
            { kind: vscode.CompletionItemKind.Value, useRange: true },
        );
        assert.strictEqual(item.insertText, '"text"');
        assert.strictEqual(item.kind, vscode.CompletionItemKind.Value);
        assert.deepStrictEqual(item.range, fromLspRange(range));
    });

    it('falls back to insertText, then to the label', () => {
        assert.strictEqual(fromLspCompletion({ label: 'a', insertText: 'b' }, { kind: 0 }).insertText, 'b');
        assert.strictEqual(fromLspCompletion({ label: 'a' }, { kind: 0 }).insertText, 'a');
    });

    it('reads every shape of hover content', () => {
        assert.strictEqual(fromLspMarkdown('**x**').value, '**x**');
        assert.strictEqual(fromLspMarkdown({ kind: 'markdown', value: '*y*' }).value, '*y*');
        assert.match(fromLspMarkdown({ language: 'css', value: 'a {}' }).value, /```css\na \{\}\n```/);
        assert.strictEqual(fromLspMarkdown(['one', 'two']).value, 'one\n\ntwo');
    });
});
