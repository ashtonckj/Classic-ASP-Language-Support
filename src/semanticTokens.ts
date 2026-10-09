/**
 * semanticTokens.ts
 *
 * The colouring of an ASP page: VBScript and SQL (asp/aspSemanticProvider) and
 * JavaScript (js/jsSemanticProvider) through one provider.
 *
 * VS Code honours only ONE DocumentSemanticTokensProvider per language.
 * Registering two (ASP + JS) meant whichever ran second silently discarded the
 * other's tokens, so one provider runs both and merges their token streams. Both
 * use COMBINED_SEMANTIC_LEGEND, so their numbers and colours agree.
 */

import * as vscode from 'vscode';
import { guarded } from './platform/guardedProvider';
import { AspSemanticTokensProvider } from './asp/aspSemanticProvider';
import { JsSemanticTokensProvider, COMBINED_SEMANTIC_LEGEND } from './js/jsSemanticProvider';

/** Reads delta-encoded token data one token at a time, at its absolute position. */
class TokenReader {
    line = 0;
    char = 0;
    private at = -5;

    constructor(readonly data: Uint32Array) { this.next(); }

    get done(): boolean { return this.at + 4 >= this.data.length; }

    /** True when this reader's token comes first (or at the same place). */
    before(other: TokenReader): boolean {
        return this.line !== other.line ? this.line < other.line : this.char <= other.char;
    }

    /** Copies the token's length, type and modifiers to `out` at `to`, then moves on. */
    take(out: Uint32Array, to: number): void {
        out[to + 2] = this.data[this.at + 2];
        out[to + 3] = this.data[this.at + 3];
        out[to + 4] = this.data[this.at + 4];
        this.next();
    }

    private next(): void {
        this.at += 5;
        if (this.done) { return; }
        const deltaLine = this.data[this.at];
        this.line += deltaLine;
        this.char = deltaLine > 0 ? this.data[this.at + 1] : this.char + this.data[this.at + 1];
    }
}

/**
 * Two token streams, each in position order as VS Code returns them, as one.
 * Merged in a single pass rather than decoded, sorted and rebuilt: the two
 * never overlap (one is VBScript, the other JavaScript), so the order is only
 * ever a choice of which stream's next token comes first.
 */
export function mergeSemanticTokens(a: Uint32Array, b: Uint32Array): Uint32Array {
    const out = new Uint32Array(Math.floor(a.length / 5) * 5 + Math.floor(b.length / 5) * 5);
    const first = new TokenReader(a);
    const second = new TokenReader(b);
    let to = 0, line = 0, char = 0;
    while (!first.done || !second.done) {
        const next = second.done || (!first.done && first.before(second)) ? first : second;
        out[to]     = next.line - line;
        out[to + 1] = next.line === line ? next.char - char : next.char;
        line = next.line;
        char = next.char;
        next.take(out, to);
        to += 5;
    }
    return out;
}

export function registerSemanticTokens(context: vscode.ExtensionContext): void {
    // Each is guarded on its own, so one failing still leaves the other's colours.
    const aspTokens = guarded('AspSemanticTokensProvider', new AspSemanticTokensProvider());
    const jsTokens  = guarded('JsSemanticTokensProvider', new JsSemanticTokensProvider());

    const toPromise = (r: vscode.ProviderResult<vscode.SemanticTokens>) =>
        r instanceof Promise ? r : Promise.resolve(r ?? undefined);

    context.subscriptions.push(
        aspTokens,
        vscode.languages.registerDocumentSemanticTokensProvider(
            'asp',
            guarded('Semantic tokens', {
                provideDocumentSemanticTokens(
                    document: vscode.TextDocument,
                    token:    vscode.CancellationToken,
                ): vscode.ProviderResult<vscode.SemanticTokens> {
                    return Promise.all([
                        toPromise(aspTokens.provideDocumentSemanticTokens(document, token)),
                        toPromise(jsTokens.provideDocumentSemanticTokens(document, token)),
                    ]).then(([asp, js]) => {
                        if (!asp && !js) { return undefined; }
                        if (!asp) { return js; }
                        if (!js)  { return asp; }

                        return new vscode.SemanticTokens(mergeSemanticTokens(asp.data, js.data));
                    });
                },
            }),
            COMBINED_SEMANTIC_LEGEND,
        ),
    );
}
