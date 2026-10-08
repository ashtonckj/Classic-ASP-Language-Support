/**
 * lazyModule.ts  (core/)
 *
 * The heavy libraries, each loaded the first time a feature needs it rather than
 * when the extension starts: TypeScript alone takes ~190 ms to load, and a page
 * with no <script> never needs it. Loading them all at activation is what made
 * every window slow to start.
 *
 * Free of vscode — the JavaScript worker loads TypeScript through here too — so a
 * library that fails to load is not logged here: the error goes to the caller,
 * and the provider guard (platform/guardedProvider) writes it to the log once.
 */

/** A loader that runs `load` once, on the first call, and hands back the same module after. */
export function lazyModule<T>(load: () => T): () => T {
    let module: T | undefined;
    return () => (module ??= load());
}

export const loadTypeScript  = lazyModule(() => require('typescript') as typeof import('typescript'));
export const loadPrettier    = lazyModule(() => require('prettier') as typeof import('prettier'));
export const loadCssService  = lazyModule(() => require('vscode-css-languageservice') as typeof import('vscode-css-languageservice'));
export const loadHtmlService = lazyModule(() => require('vscode-html-languageservice') as typeof import('vscode-html-languageservice'));
export const loadEmmetHelper = lazyModule(() => require('@vscode/emmet-helper') as typeof import('@vscode/emmet-helper'));
