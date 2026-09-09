import * as assert from 'assert';
import * as vscode from 'vscode';
import * as ts from 'typescript';

// Typing `function(` in a <script> block froze the Extension Development Host.
// The cause was the Outline provider: TypeScript's error recovery gives a
// half-typed `function(` a name node that EXISTS but is empty, and
// vscode.DocumentSymbol rejects an empty name — so the provider threw on every
// keystroke. jsDocumentSymbols.test.ts covers that directly; this drives the
// whole set of providers through a real editor as a backstop.
//
// It also hooks ts.Debug, because the jsUtils wrappers catch every throw out of
// the language service: without the hook a tripped TypeScript assertion is
// invisible outside a debug session, where its `debugger;` statement stops the
// host dead. That is how a '(' handed to the completion API went unnoticed here
// while halting a real session on every call typed. This runs INSIDE the
// extension host, so `typescript` here is the very module instance the
// extension uses.

interface AssertHit { kind: string; message: string; stack: string; }

const hits: AssertHit[] = [];

function installHook(): () => void {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const debug = (ts as any).Debug;
    const originalFail = debug.fail;
    const originalAssert = debug.assert;
    const originalAssertNever = debug.assertNever;

    debug.fail = function (message?: string, mark?: unknown) {
        hits.push({ kind: 'fail', message: String(message ?? ''), stack: new Error().stack ?? '' });
        return originalFail.call(this, message, mark);
    };
    // assertNever reaches fail() through the module's own local binding, so the
    // hook above cannot see it. Hooking it separately is what caught a '('
    // being passed to the completion API as a trigger character.
    debug.assertNever = function (member: unknown, ...rest: unknown[]) {
        hits.push({
            kind: 'assertNever',
            message: JSON.stringify(member),
            stack: new Error().stack ?? '',
        });
        return originalAssertNever.call(this, member, ...rest);
    };
    // assert runs hundreds of thousands of times; only a falsy condition throws.
    debug.assert = function (condition: unknown, ...rest: unknown[]) {
        if (!condition) {
            hits.push({ kind: 'assert', message: String(rest[0] ?? ''), stack: new Error().stack ?? '' });
        }
        return originalAssert.call(this, condition, ...rest);
    };

    return () => {
        debug.fail = originalFail;
        debug.assert = originalAssert;
        debug.assertNever = originalAssertNever;
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function describeHits(): string {
    return hits.slice(0, 3).map(h => {
        const frames = h.stack.split('\n').slice(1, 9).map(l => '      ' + l.trim()).join('\n');
        return `  ts.Debug.${h.kind}(${JSON.stringify(h.message)})\n${frames}`;
    }).join('\n\n');
}

suite('A half-typed declaration never throws out of a provider (integration)', () => {
    let restore: () => void;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension('ashtonckj.classic-asp-language-support');
        await ext?.activate();
        restore = installHook();
    });

    suiteTeardown(() => { restore?.(); });

    /** Types `text` one character at a time, letting every provider react. */
    async function typeInScript(prefix: string, text: string): Promise<vscode.TextEditor> {
        const doc = await vscode.workspace.openTextDocument({
            language: 'asp',
            content: `<%@ Language="VBScript" %>\n<script>\n${prefix}\n</script>\n`,
        });
        const editor = await vscode.window.showTextDocument(doc);
        const line = 2;
        editor.selection = new vscode.Selection(line, prefix.length, line, prefix.length);

        for (const ch of text) {
            await vscode.commands.executeCommand('type', { text: ch });
            await sleep(15);
        }
        // Let the debounced diagnostics (750 ms) and the semantic pass run.
        await sleep(1400);
        return editor;
    }

    /** Drives completion (including item resolution) and signature help. */
    async function askProviders(editor: vscode.TextEditor, trigger?: string): Promise<void> {
        const pos = editor.selection.active;
        await vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider', editor.document.uri, pos, trigger, 50,
        );
        await vscode.commands.executeCommand(
            'vscode.executeSignatureHelpProvider', editor.document.uri, pos, trigger,
        );
        await vscode.commands.executeCommand(
            'vscode.executeHoverProvider', editor.document.uri, pos,
        );
        // The Outline is where this actually broke: an unnamed declaration made
        // vscode.DocumentSymbol throw, which VS Code reports as an extension
        // error and which halts the Extension Host under a debug session.
        await vscode.commands.executeCommand(
            'vscode.executeDocumentSymbolProvider', editor.document.uri,
        );
        await sleep(200);
    }

    const CASES: Array<[string, string, string]> = [
        ['function( on its own',        '',              'function('],
        ['var f = function(',           'var f = ',      'function('],
        ['named function foo(',         '',              'function foo('],
        ['function( inside a function', 'function o() {', 'function('],
        ['alert(',                      '',              'alert('],
        ['a bare open paren',           'var x = ',      '('],
        ['function with no paren',      '',              'function'],
        // '(' is a registered completion trigger character, so each of these
        // hands it to the completion API on the final keystroke.
        ['a method call',               '',              'document.getElementById('],
        ['a call inside a block',       'if (x) { ',     'foo('],
    ];

    for (const [label, prefix, typed] of CASES) {
        test(label, async () => {
            hits.length = 0;
            const editor = await typeInScript(prefix, typed);
            await askProviders(editor, typed.endsWith('(') ? '(' : undefined);
            assert.strictEqual(
                hits.length, 0,
                `TypeScript assertion tripped ${hits.length} time(s):\n${describeHits()}`,
            );
        });
    }
});
