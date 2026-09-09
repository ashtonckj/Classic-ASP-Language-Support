import * as assert from 'assert';
import * as vscode from 'vscode';
import { JsDocumentSymbolProvider } from '../../providers/jsDocumentSymbolProvider';
import { disposeJsLanguageService } from '../../utils/jsUtils';

// The Outline is rebuilt on every keystroke, over a half-typed document, from an
// AST full of TypeScript's error-recovery nodes. Typing `function(` produces a
// FunctionDeclaration whose `name` node EXISTS but whose text is empty — so a
// `node.name` truthiness check passes and vscode.DocumentSymbol then rejects the
// empty name ("name must not be falsy"). That threw out of the provider on every
// keystroke until the name was finished, which VS Code reports as an extension
// error and which stops the Extension Host dead under a debug session.

after(() => { disposeJsLanguageService(); });

function fakeDoc(text: string): vscode.TextDocument {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') { lineStarts.push(i + 1); }
    }
    return {
        languageId: 'asp',
        version: 1,
        uri: { fsPath: 'C:\\site\\page.asp', scheme: 'file', toString: () => 'file:///page.asp' },
        getText: () => text,
        lineCount: lineStarts.length,
        lineAt: (n: number) => ({
            text: text.slice(lineStarts[n], lineStarts[n + 1] ?? text.length).replace(/\r?\n$/, ''),
        }),
        offsetAt: (p: { line: number; character: number }) => lineStarts[p.line] + p.character,
        positionAt: (offset: number) => {
            let lo = 0, hi = lineStarts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
            }
            return { line: lo, character: offset - lineStarts[lo] };
        },
    } as unknown as vscode.TextDocument;
}

const provider = new JsDocumentSymbolProvider();
const NOT_CANCELLED = { isCancellationRequested: false } as vscode.CancellationToken;

const symbolsFor = (script: string): vscode.DocumentSymbol[] => {
    const result = provider.provideDocumentSymbols(
        fakeDoc(`<script>\n${script}\n</script>\n`),
        NOT_CANCELLED,
    );
    return (result as vscode.DocumentSymbol[]) ?? [];
};

const names = (script: string) => symbolsFor(script).map(s => s.name).sort();

describe('JS document symbols survive a half-typed declaration', () => {
    // Each of these is what the buffer looks like mid-keystroke.
    const HALF_TYPED = [
        'function(',
        'function (',
        'var f = function(',
        'function foo(',
        'function outer() {\n  function(\n}',
        'class {',
        'class Foo {\n  (\n}',
        'class Foo {\n  bar(\n}',
        'var ',
        'var x =',
        'document.addEventListener("click", function(',
        '[].forEach(function(',
        'function(a, b',
        'async function(',
    ];

    for (const script of HALF_TYPED) {
        it(`does not throw for ${JSON.stringify(script)}`, () => {
            assert.doesNotThrow(() => symbolsFor(script));
        });
    }

    it('reports nothing at all for a nameless function', () => {
        assert.deepStrictEqual(names('function('), []);
    });

    it('reports nothing for a nameless class', () => {
        assert.deepStrictEqual(names('class {'), []);
    });
});

// The guard must not have cost us the symbols that do have names.
describe('JS document symbols still report named declarations', () => {
    it('reports a function declaration', () => {
        assert.deepStrictEqual(names('function greet(name) {}'), ['greet']);
    });

    it('reports a function held in a variable', () => {
        assert.deepStrictEqual(names('var greet = function(name) {};'), ['greet']);
    });

    it('reports an arrow function held in a variable', () => {
        assert.deepStrictEqual(names('const greet = (name) => {};'), ['greet']);
    });

    it('reports a class and its members', () => {
        const [cls] = symbolsFor('class Person {\n  constructor(n) {}\n  greet() {}\n}');
        assert.strictEqual(cls.name, 'Person');
        assert.deepStrictEqual(cls.children.map(c => c.name).sort(), ['constructor', 'greet']);
    });

    it('reports a named function alongside a half-typed one', () => {
        assert.deepStrictEqual(names('function done() {}\nfunction('), ['done']);
    });

    it('reports a top-level constant', () => {
        assert.deepStrictEqual(names('const MAX = 10;'), ['MAX']);
    });
});
