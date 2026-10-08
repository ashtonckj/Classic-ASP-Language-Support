import * as assert from 'assert';
import type * as TS from 'typescript';
import { JsLanguageService, TextSnapshot, VIRTUAL_FILENAME } from '../../js/jsUtils';
import { loadTypeScript } from '../../core/lazyModule';

// The JavaScript service re-parses only what an edit changed (TextSnapshot
// tells TypeScript the changed range). An incremental parse that drifts from
// a fresh one would show wrong hovers, completions and squiggles with nothing
// to say why, so this checks the two trees are the same after every one of
// hundreds of random edits — the half-typed braces, quotes and comments of
// real typing included — and after a switch to another page's script.

const ts: typeof TS = loadTypeScript();

const SCRIPT = [
    'const API_URL = "https://example.com/api";',
    'let count = 0;',
    'function greet(name, greeting) {',
    '    const text = `${greeting}, ${name}!`;',
    '    if (text.length > 10) { console.log(text); } else { return null; }',
    '    return text;',
    '}',
    'class Basket {',
    '    constructor(items) { this.items = items || []; }',
    '    add(item) { this.items.push(item); return this; }',
    '    /* the total, in pence */',
    '    get total() { return this.items.reduce((sum, i) => sum + i.price, 0); }',
    '}',
    'document.querySelectorAll(".row").forEach(row => {',
    '    row.addEventListener("click", function (event) {',
    '        // a comment with a { brace and a "quote',
    '        event.preventDefault();',
    '        count += 1;',
    '    });',
    '});',
    'const pattern = /[a-z]+\\/(\\d+)/g;',
    'for (let i = 0; i < 10; i++) { while (count > i) { count--; } }',
    'try { JSON.parse("{}"); } catch (e) { console.error(e); } finally { count = 0; }',
].join('\n');

const SNIPPETS = [
    '{', '}', '(', ')', '[', ']', '"', "'", '`', '${', '/*', '*/', '//', '\n', ';', ',', '=>', '<', '>', '/',
    'function f(a) {', 'return x;', 'const y = 1;', 'if (a) {', '} else {', 'class C {', 'x', 'item', '  ', '.',
];

/** A seeded random number in [0, 1), so a failure can be replayed. */
function random(seed: number): () => number {
    return () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
}

/** Every node of a tree, as kind and span, in order. */
function shape(file: TS.SourceFile): string[] {
    const nodes: string[] = [];
    const visit = (node: TS.Node): void => {
        nodes.push(`${ts.SyntaxKind[node.kind]}@${node.pos}-${node.end}`);
        ts.forEachChild(node, visit);
    };
    visit(file);
    return nodes;
}

/** The errors the parser itself found in a tree (TypeScript keeps them on the SourceFile, unexported). */
function parseErrors(file: TS.SourceFile): readonly TS.Diagnostic[] {
    return (file as TS.SourceFile & { parseDiagnostics: readonly TS.Diagnostic[] }).parseDiagnostics;
}

function errors(diagnostics: readonly TS.Diagnostic[]): string[] {
    return diagnostics.map(d => `${d.start}:${d.length}:${d.code}`);
}

describe('JsLanguageService — an incremental parse gives the tree a fresh one does', function () {
    this.timeout(60_000);

    it('after each of 400 random edits, and after switching pages', () => {
        const service = new JsLanguageService();
        const next = random(7);
        let text = SCRIPT;

        for (let step = 0; step < 400; step++) {
            if (step === 200) {
                // Another page's script: nothing in common with the last.
                text = 'var other = [1, 2, 3].map(n => n * 2);\nfunction other2() { return other; }\n';
            } else {
                const at = Math.floor(next() * (text.length + 1));
                const removed = next() < 0.4 ? Math.floor(next() * 12) : 0;
                const inserted = next() < 0.7 ? SNIPPETS[Math.floor(next() * SNIPPETS.length)] : '';
                text = text.slice(0, at) + inserted + text.slice(at + removed);
            }

            service.updateContent(text);
            const program = service.getProgram()!;
            const incremental = program.getSourceFile(VIRTUAL_FILENAME)!;
            const fresh = ts.createSourceFile(VIRTUAL_FILENAME, text, incremental.languageVersion, true, ts.ScriptKind.JS);

            assert.strictEqual(incremental.text, text, `step ${step}: the service holds another text`);
            assert.deepStrictEqual(shape(incremental), shape(fresh), `step ${step}: the trees differ`);
            assert.deepStrictEqual(
                errors(parseErrors(incremental)), errors(parseErrors(fresh)),
                `step ${step}: the syntax errors differ`,
            );
        }
    });

    it('really reuses the tree: a statement the edit did not touch is the same node', () => {
        const service = new JsLanguageService();
        service.updateContent(SCRIPT);
        const statements = service.getProgram()!.getSourceFile(VIRTUAL_FILENAME)!.statements;
        const before = statements[0];
        const count = statements.length;
        service.updateContent(SCRIPT + '\nlet added = 1;');
        const after = service.getProgram()!.getSourceFile(VIRTUAL_FILENAME)!;
        assert.strictEqual(after.statements[0], before, 'a fresh parse would have made a new node');
        assert.strictEqual(after.statements.length, count + 1);
    });

    it('describes the change as the stretch between the shared start and end', () => {
        const range = new TextSnapshot('let total = 10;').getChangeRange(new TextSnapshot('let count = 10;'))!;
        assert.deepStrictEqual([range.span.start, range.span.length, range.newLength], [4, 5, 5]);
        assert.strictEqual(new TextSnapshot('x').getChangeRange(ts.ScriptSnapshot.fromString('x')), undefined,
            'a snapshot it did not make is parsed in full');
    });
});
