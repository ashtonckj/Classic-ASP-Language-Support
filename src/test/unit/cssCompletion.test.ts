import * as assert from 'assert';
import * as vscode from 'vscode';
import { CssCompletionProvider } from '../../css/cssCompletionProvider';
import { CssHoverProvider } from '../../css/cssHoverProvider';
import { fakeDocument } from './_helpers';

// CSS help in a <style> block and a style="" value, as a .html file gives it.
describe('CssCompletionProvider', () => {
    const provider = new CssCompletionProvider();
    const complete = (text: string) => {
        const at = text.indexOf('|');
        const document = fakeDocument(text.replace('|', ''));
        const items = provider.provideCompletionItems(
            document, document.positionAt(at), undefined as never, { triggerKind: 0 } as never,
        );
        return { document, items };
    };
    const replaced = (text: string, label: string) => {
        const { document, items } = complete(text);
        const item = items.find(i => i.label === label);
        assert.ok(item, `no ${label}`);
        const range = item.range as vscode.Range;
        return document.getText(range);
    };

    // The editor's word stops at a `-`; without the service's range, picking
    // `background-color` after `background-co` wrote `background-background-color`.
    it("replaces the whole of a hyphenated property, in a block and in a style=''", () => {
        assert.strictEqual(replaced('<style>\n.a { background-co| }\n</style>', 'background-color'), 'background-co');
        assert.strictEqual(replaced('<p style="margin: 0; background-co|">x</p>', 'background-color'), 'background-co');
    });

    it('offers a value where the caret is, not two characters on', () => {
        assert.strictEqual(replaced('<p style="display: fl|">x</p>', 'flex'), 'fl');
    });

    it('offers declarations, not selectors or at-rules, in a style attribute', () => {
        for (const text of ['<p style="|">x</p>', '<p style="color: red; |">x</p>']) {
            const labels = complete(text).items.map(i => String(i.label));
            assert.ok(labels.includes('color'), text);
            assert.deepStrictEqual(labels.filter(l => /^[@.]/.test(l)), [], text);
        }
    });

    it('offers nothing in the ASP inside a style attribute', () => {
        assert.deepStrictEqual(complete('<p style="color: <%= c| %>">x</p>').items, []);
    });
});

describe('CssHoverProvider', () => {
    it('describes the property under the caret in a style attribute, to its last letter', () => {
        const text = '<p style="color: red">x</p>';
        const document = fakeDocument(text);
        const hover = new CssHoverProvider().provideHover(document, document.positionAt(text.indexOf('r:')));
        // The stub keeps the contents as given, one MarkdownString here.
        assert.ok(hover && /color/i.test((hover.contents as unknown as vscode.MarkdownString).value));
    });
});
