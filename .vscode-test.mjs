import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a REAL VS Code Extension Host — use these for
// anything that needs live editor behaviour (the Enter/Tab keybinding handlers,
// commands, providers driven end-to-end). They are separate from the fast unit
// tests in src/test/unit/ (plain mocha + a `vscode` stub, run via `npm run
// test:unit`), so this config deliberately scopes to out/test/integration only.
export default defineConfig({
    files: 'out/test/integration/**/*.test.js',
    version: 'stable',
    // Keep other extensions out so nothing else claims the global `type` command
    // or otherwise interferes; the extension under test is still loaded.
    launchArgs: ['--disable-extensions'],
    mocha: {
        ui: 'tdd',
        timeout: 60000,
        // Waits for the extension to activate before any test runs. It declares
        // onLanguage:asp, so it does not exist until something opens an .asp
        // document, and activating takes about a second — long enough that the
        // first test of several suites used to act on an editor with no
        // providers registered yet, and simply see the command do nothing.
        //
        // The file has to export `mochaGlobalSetup`: @vscode/test-cli requires
        // it and awaits that export itself, and does not pass mocha's root-hook
        // plumbing through, so a `mochaHooks` export is silently ignored.
        require: './out/test/integration/_activate.js',
    },
});
