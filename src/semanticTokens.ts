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

type Token = [line: number, char: number, length: number, type: number, modifiers: number];

/** Delta-encoded SemanticTokens data back to absolute positions. */
function decodeSemanticTokenData(data: Uint32Array): Token[] {
    const tokens: Token[] = [];
    let line = 0, char = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaChar = data[i + 1];
        if (deltaLine > 0) { line += deltaLine; char = deltaChar; }
        else               { char += deltaChar; }
        tokens.push([line, char, data[i + 2], data[i + 3], data[i + 4]]);
    }
    return tokens;
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

                        // Merge both token streams, sort by position, rebuild.
                        const all = [...decodeSemanticTokenData(asp.data), ...decodeSemanticTokenData(js.data)];
                        all.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);

                        const builder = new vscode.SemanticTokensBuilder(COMBINED_SEMANTIC_LEGEND);
                        for (const [l, c, len, type, mod] of all) { builder.push(l, c, len, type, mod); }
                        return builder.build();
                    });
                },
            }),
            COMBINED_SEMANTIC_LEGEND,
        ),
    );
}
