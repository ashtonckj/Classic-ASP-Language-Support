// Minimal stand-in for the 'vscode' module used by the plain-mocha unit harness.
//
// Several provider files `import * as vscode from 'vscode'` at the top purely for
// the API surface, but the *pure* logic under test (e.g. extractSymbols) never
// touches it. The real 'vscode' module only exists inside the Extension Host, so
// _mochaSetup.ts redirects require('vscode') here to let those modules load.
//
// It is intentionally empty: any test that actually calls a vscode API should run
// in the Extension Host, not here. Extend only if a load-time reference appears.
export {};
