import * as assert from 'assert';
import * as ts from 'typescript';
import {
    buildVirtualJsContent,
    disposeJsLanguageService,
    getJsLanguageService,
    isTsTriggerCharacter,
} from '../../utils/jsUtils';

// Typing '(' in a <script> block halted the Extension Development Host.
//
// VS Code registers '(' as a completion trigger character so the suggestion
// list reopens on a call, and hands that character to the provider. TypeScript's
// completion API accepts a much smaller set: its isValidTrigger switch has no
// case for '(' and falls through to Debug.assertNever, whose fail() begins with
// a `debugger;` statement and then throws. So every '(' stopped a debug session
// on that line, and outside one the throw was swallowed by the service wrapper,
// silently costing the completion list.
//
// These tests hook Debug.assertNever rather than Debug.fail: assertNever reaches
// fail through the module's own local binding, which a hook on the exported
// Debug.fail cannot intercept.

const VS_CODE_TRIGGERS = ['.', '('];

interface Trip { char: string; detail: string; }

/** Records every assertNever the language service reaches, and keeps throwing. */
function recordAssertNever(trips: Trip[], char: string): () => void {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const debug = (ts as any).Debug;
    const original = debug.assertNever;
    debug.assertNever = function (member: unknown, ...rest: unknown[]) {
        trips.push({ char, detail: JSON.stringify(member) });
        return original.call(this, member, ...rest);
    };
    return () => { debug.assertNever = original; };
    /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Asks for completions at the end of `marker`, as the provider would. */
function completionsAfter(script: string, marker: string, trigger: string | undefined) {
    const doc = `<script>\n${script}\n</script>\n`;
    const caret = doc.indexOf(marker) + marker.length;
    const { virtualContent, preambleLength } = buildVirtualJsContent(doc, caret);
    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);
    return svc.getCompletions(caret + preambleLength, trigger);
}

after(() => { disposeJsLanguageService(); });

describe('A VS Code trigger character never trips a TypeScript assertion', () => {
    // Each is a place a '(' is genuinely typed in a Classic ASP page.
    const SCRIPTS: Array<[string, string]> = [
        ['alert(',                          'alert('],
        ['function(',                       'function('],
        ['var f = function(',               'function('],
        ['document.getElementById(',        'getElementById('],
        ['if (x) { foo(',                   'foo('],
        ['window.attachEvent("onload", (',  '", ('],
    ];

    for (const [script, marker] of SCRIPTS) {
        for (const trigger of VS_CODE_TRIGGERS) {
            it(`survives ${JSON.stringify(trigger)} after ${JSON.stringify(script)}`, () => {
                const trips: Trip[] = [];
                const restore = recordAssertNever(trips, trigger);
                try {
                    completionsAfter(script, marker, trigger);
                } finally {
                    restore();
                }
                assert.deepStrictEqual(
                    trips, [],
                    `TypeScript rejected the trigger character: ${JSON.stringify(trips)}`,
                );
            });
        }
    }

    it('still offers a list after a call paren, rather than losing it to a throw', () => {
        const info = completionsAfter('alert(', 'alert(', '(');
        assert.ok(info, 'no CompletionInfo at all — the throw was swallowed again');
        assert.ok(
            info.entries.length > 100,
            `expected the usual global list; got ${info.entries.length} entries`,
        );
    });

    it('still narrows to members after a dot', () => {
        const info = completionsAfter('document.', 'document.', '.');
        assert.ok(info, 'no CompletionInfo after a dot');
        const names = info.entries.map(e => e.name);
        assert.ok(names.includes('getElementById'), 'document members should be offered');
        assert.ok(!names.includes('alert'), 'a dot must not offer globals');
    });
});

describe('isTsTriggerCharacter matches TypeScript CompletionsTriggerCharacter', () => {
    for (const ch of ['.', '"', "'", '`', '/', '@', '<', '#', ' ']) {
        it(`accepts ${JSON.stringify(ch)}`, () => {
            assert.strictEqual(isTsTriggerCharacter(ch), true);
        });
    }

    // '(' is registered by this extension; '[' and ',' are the neighbouring
    // characters most likely to be added to that registration later.
    for (const ch of ['(', '[', ',', ')', '=', 'a', '']) {
        it(`rejects ${JSON.stringify(ch)}`, () => {
            assert.strictEqual(isTsTriggerCharacter(ch), false);
        });
    }

    it('rejects undefined', () => {
        assert.strictEqual(isTsTriggerCharacter(undefined), false);
    });
});

// TypeScript offers a function that has no name yet — the moment after
// `function` is typed and before the name is — as a global completion whose
// name is the empty string. Turned into a CompletionItem that is an item with
// no label, which VS Code drops with "did IGNORE invalid completion item from
// ashtonckj.classic-asp-language-support" in the log. The provider filters it,
// and this records the upstream behaviour that makes the filter necessary, so
// the filter is not later removed as pointless.
describe('An unnamed function does not reach the suggest widget', () => {

    /** True when the raw TypeScript entries include one with no name. */
    function hasNamelessEntry(script: string, caretMarker: string): boolean {
        const doc   = `<script>\n${script}\n</script>\n`;
        const caret = doc.indexOf(caretMarker) + caretMarker.length;
        const { virtualContent, preambleLength } = buildVirtualJsContent(doc, caret);
        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);
        const info = svc.getCompletions(caret + preambleLength, undefined);
        return (info?.entries ?? []).some(entry => entry.name === '');
    }

    it('is what TypeScript really returns for a half-typed function', () => {
        assert.ok(
            hasNamelessEntry('function', '<script>'),
            'TypeScript no longer offers a nameless entry — the provider filter may be removable',
        );
    });

    it('is not returned once the function has a name', () => {
        assert.ok(!hasNamelessEntry('function add() {}', '<script>'));
        assert.ok(!hasNamelessEntry('var x = 1;', '<script>'));
    });

    it('is dropped by the same rule that hides the projection variables', () => {
        // The provider's filter, applied to the entry names it would receive.
        const offerable = (name: string) =>
            !name.startsWith('_asp_') && name !== '_asp' && name !== '';

        assert.strictEqual(offerable(''), false, 'a nameless entry must not be offered');
        assert.strictEqual(offerable('_asp'), false);
        assert.strictEqual(offerable('_asp_x'), false);
        assert.strictEqual(offerable('addRow'), true);
    });
});
