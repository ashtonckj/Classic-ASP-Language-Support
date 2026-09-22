import * as vscode from 'vscode';

// Mocha root hooks for the integration suite, loaded through `mocha.require` in
// .vscode-test.mjs. This file is not a `*.test.js`, so it is not collected as a
// suite of its own.
//
// The extension declares `onLanguage:asp`, so it does not exist until something
// opens an .asp document — and activating it takes about a second. The first
// test to open one therefore triggered activation and then acted immediately,
// before `asp.insertTab` was registered, before the comment rules were loaded,
// before the auto-close and Emmet providers existed. Those tests failed with the
// editor simply doing nothing: Tab inserted no indent, Toggle Comment returned
// the line unchanged, the Emmet completion list came back without its items.
//
// Whether a given test won that race depended on how busy the machine was, which
// is why roughly half of all runs failed, always in the first tests of the
// suites that touch the editor, and why the same run repeated could pass. Tests
// that happened to be slow for other reasons passed reliably.
//
// Waiting for activation once, before anything runs, removes the race for every
// suite rather than leaving each to guess at a sleep long enough to cover it.

const EXTENSION_ID = 'ashtonckj.classic-asp-language-support';

/**
 * Languages whose configuration the zone-aware features read.
 *
 * A language VS Code has never opened has no configuration loaded, so Toggle
 * Comment inside a `<style>` block is a silent no-op until something has opened
 * a CSS document once. Opening one of each here makes that deterministic too,
 * rather than depending on which test file happened to run first.
 */
const EMBEDDED_LANGUAGES = ['html', 'css', 'javascript'];

/**
 * `mochaGlobalSetup` rather than `mochaHooks`: @vscode/test-cli requires this
 * file itself and awaits this export before calling mocha.run, and it does not
 * pass mocha's own root-hook plumbing through. A `mochaHooks` export here is
 * silently ignored — which is worth knowing, because it looks like it works.
 */
export async function mochaGlobalSetup(): Promise<void> {
    const started = Date.now();

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (!extension) {
        throw new Error(
            `${EXTENSION_ID} is not installed in the test instance — `
            + 'the integration suite cannot test an extension that is not there.',
        );
    }
    if (!extension.isActive) { await extension.activate(); }

    // Activation registers the providers, but `onLanguage:asp` only fires for a
    // real .asp document, and some services initialise on first use. Open one so
    // the first real test starts from a warm editor.
    const asp = await vscode.workspace.openTextDocument({ language: 'asp', content: '<% %>\n' });
    await vscode.window.showTextDocument(asp);

    for (const language of EMBEDDED_LANGUAGES) {
        const document = await vscode.workspace.openTextDocument({ language, content: '' });
        await vscode.window.showTextDocument(document, { preview: true });
    }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log(`[asp] integration warm-up finished in ${Date.now() - started} ms`);
}
