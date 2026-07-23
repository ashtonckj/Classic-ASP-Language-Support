// Minimal stand-in for the 'vscode' module used by the plain-mocha unit harness.
//
// Several provider/formatter files `import * as vscode from 'vscode'` at the top.
// The real module only exists inside the Extension Host, so _mochaSetup.ts
// redirects require('vscode') here. We expose just enough surface for the PURE
// logic under test to run:
//   • workspace.getConfiguration(...).get(key, default) → returns the default, so
//     getAspSettings()/getPrettierSettings() yield the documented defaults.
//   • window.* → no-ops (warnings, progress, output channels) so formatting can
//     run headlessly; withProgress simply invokes and returns its task.
// Anything that needs real editor behaviour must run in the Extension Host.

export const workspace = {
    getConfiguration: () => ({
        get: (_key: string, defaultValue?: unknown) => defaultValue,
    }),
};

export const window = {
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    withProgress: (_opts: unknown, task: (progress: { report: () => void }) => unknown) =>
        task({ report: () => { /* no-op */ } }),
    createOutputChannel: () => ({
        clear: () => { /* no-op */ },
        append: () => { /* no-op */ },
        appendLine: () => { /* no-op */ },
        show: () => { /* no-op */ },
        dispose: () => { /* no-op */ },
    }),
};

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
