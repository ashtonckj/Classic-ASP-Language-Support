/**
 * jsSemanticTokensProvider.ts  (providers/)
 *
 * Semantic token colouring for JavaScript inside <script> blocks,
 * powered by the TypeScript Language Service's getEncodedSemanticClassifications.
 *
 * This gives the same colour distinctions that VS Code applies to plain .js
 * files: functions are coloured differently from variables, parameters from
 * locals, types from values, etc.
 *
 * Token type / modifier names match VS Code's standard semantic token legend
 * so they pick up whatever theme colours the user has configured for JS.
 *
 * Registration: uses registerDocumentSemanticTokensProvider with a SEPARATE
 * legend from the ASP VBScript legend so the two never interfere.
 */

import * as vscode from 'vscode';
import * as ts     from 'typescript';
import {
    buildVirtualJsContent,
    getJsLanguageService,
} from '../utils/jsUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Legend — standard VS Code semantic token types used for JS/TS
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN_TYPES = [
    'namespace', 'type', 'class', 'enum', 'interface', 'struct',
    'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
    'event', 'function', 'method', 'macro', 'keyword', 'modifier',
    'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
];
const TOKEN_MODIFIERS = [
    'declaration', 'definition', 'readonly', 'static', 'deprecated',
    'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
];

export const JS_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
    TOKEN_TYPES,
    TOKEN_MODIFIERS
);

// ─────────────────────────────────────────────────────────────────────────────
// Map TypeScript's 20-20 classification token type/modifier integers to our
// legend indices.  TS encodes them in triples: [offset, length, classType].
//
// ts.TokenEncodingConsts (from TypeScript source):
//   type is bits 0..7, modifier mask is bits 8..
//
// The token type numbers from ts.SemanticClassificationFormat.TwentyTwenty:
// ─────────────────────────────────────────────────────────────────────────────
const TS_TYPE_MAP: Record<number, string> = {
    1:  'class',
    2:  'enum',
    3:  'interface',
    4:  'namespace',
    5:  'typeParameter',
    6:  'type',
    7:  'parameter',
    8:  'variable',
    9:  'enumMember',
    10: 'property',
    11: 'function',
    12: 'method',
};

const TS_MOD_MAP: Record<number, string> = {
    1:   'declaration',
    2:   'static',
    4:   'async',
    8:   'readonly',
    16:  'defaultLibrary',
    32:  'definition',   // local — closest match in legend
};

function tsTypeToLegendIndex(tsType: number): number {
    const name = TS_TYPE_MAP[tsType];
    if (!name) { return -1; }
    return TOKEN_TYPES.indexOf(name);
}

function tsModsToLegendBits(tsMods: number): number {
    let bits = 0;
    for (const [bit, name] of Object.entries(TS_MOD_MAP)) {
        if (tsMods & Number(bit)) {
            const idx = TOKEN_MODIFIERS.indexOf(name);
            if (idx !== -1) { bits |= (1 << idx); }
        }
    }
    return bits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────
export class JsSemanticTokensProvider
    implements vscode.DocumentSemanticTokensProvider
{
    provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token:    vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SemanticTokens> {

        const content = document.getText();
        // Pass offset 0 — we need the full virtual content for the whole doc
        const { virtualContent } = buildVirtualJsContent(content, 0);

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        const builder = new vscode.SemanticTokensBuilder(JS_SEMANTIC_LEGEND);

        // Ask TS for classifications over the entire virtual document
        const result = svc.getEncodedSemanticClassifications(
            0, virtualContent.length
        );

        const spans = result.spans;
        // spans is a flat array of [offset, length, encodedClassification, ...]
        for (let i = 0; i + 2 < spans.length; i += 3) {
            if (token.isCancellationRequested) { break; }

            const offset      = spans[i];
            const length      = spans[i + 1];
            const encoded     = spans[i + 2];

            // Decode TypeScript's token encoding:
            // type = bits 0..7, modifiers = bits 8+
            const tsType = encoded & 0xFF;
            const tsMods = (encoded >> 8) & 0xFF;

            const typeIdx = tsTypeToLegendIndex(tsType);
            if (typeIdx === -1) { continue; }

            const modBits = tsModsToLegendBits(tsMods);

            const pos = document.positionAt(offset);
            builder.push(pos.line, pos.character, length, typeIdx, modBits);
        }

        return builder.build();
    }
}