// Loaded by mocha (via .mocharc.json `require`) BEFORE any test file. Installs a
// module-resolution hook so `require('vscode')` returns the stub in _vscodeStub.ts.
// This lets us unit-test pure logic that lives in files which import 'vscode' at
// the top (e.g. extractSymbols in providers/includeProvider.ts) without the
// Extension Host. Modules that don't import 'vscode' (zoneUtils, cssUtils) are
// unaffected — the hook only fires for the exact request 'vscode'.

const Module: any = require('module');
const stubPath: string = require.resolve('./_vscodeStub.js');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
    if (request === 'vscode') { return stubPath; }
    return originalResolveFilename.call(this, request, ...rest);
};
