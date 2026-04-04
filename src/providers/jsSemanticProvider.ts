/**
 * jsSemanticTokensProvider.ts  (providers/)
 *
 * Semantic token colouring for JavaScript inside <script> blocks.
 *
 * Deliberately matches what VS Code's built-in JavaScript semantic provider
 * emits — specifically:
 *
 *   • 'parameter'  — function/arrow/callback parameters  (e.g. `textarea`)
 *   • 'variable'   — only globals from defaultLibrary    (e.g. `document`,
 *                    `window`, `console`) — NOT plain var/let/const locals
 *   • 'property'   — object members                     (e.g. `.style`)
 *   • 'method'     — callable members                   (e.g. `.addEventListener`)
 *   • 'function'   — named function declarations
 *   • 'class'      — class names
 *   • 'enumMember' — enum values
 *
 * Suppressed (to avoid noise matching VS Code's own behaviour):
 *   • 'variable' with 'declaration' modifier — plain `var x` / `let x` / `const x`
 *     locals get no semantic colour, just like in a real .js file
 *   • 'variable' without 'defaultLibrary' — local variables that aren't
 *     built-in globals are left for syntax highlighting to handle
 *
 * This gives the correct result for the common case:
 *
 *   document.querySelectorAll('.x').forEach(textarea => {
 *       textarea.addEventListener('input', function() { ... });
 *   });
 *
 *   `document`  → variable + defaultLibrary  → coloured as a global
 *   `textarea`  → parameter                  → coloured as a parameter
 *   `.addEventListener` → method             → coloured as a method
 */

import * as vscode from 'vscode';
import {
    buildVirtualJsContent,
    getJsLanguageService,
} from '../utils/jsUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Legend — standard VS Code semantic token names
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
// TypeScript TwentyTwenty encoding constants (hardcoded — ts.TokenType is
// not exported in all TS versions so we use the raw numeric values).
//
// Token types (bits 0–7 of the encoded value):
//   1=class  2=enum  3=interface  4=namespace  5=typeParameter  6=type
//   7=parameter  8=variable  9=enumMember  10=property  11=function  12=method
//
// Token modifiers (bits 8+ of the encoded value, each bit is one flag):
//   bit 0 (1)  = declaration
//   bit 1 (2)  = static
//   bit 2 (4)  = async
//   bit 3 (8)  = readonly
//   bit 4 (16) = defaultLibrary
//   bit 5 (32) = local
// ─────────────────────────────────────────────────────────────────────────────
const TS_TYPE_CLASS         = 1;
const TS_TYPE_ENUM          = 2;
const TS_TYPE_INTERFACE     = 3;
const TS_TYPE_NAMESPACE     = 4;
const TS_TYPE_TYPE_PARAM    = 5;
const TS_TYPE_TYPE          = 6;
const TS_TYPE_PARAMETER     = 7;
const TS_TYPE_VARIABLE      = 8;
const TS_TYPE_ENUM_MEMBER   = 9;
const TS_TYPE_PROPERTY      = 10;
const TS_TYPE_FUNCTION      = 11;
const TS_TYPE_METHOD        = 12;

const TS_MOD_DECLARATION    = 1;
const TS_MOD_STATIC         = 2;
const TS_MOD_ASYNC          = 4;
const TS_MOD_READONLY       = 8;
const TS_MOD_DEFAULT_LIB    = 16;
// const TS_MOD_LOCAL       = 32;  // unused directly but relevant for filtering

// Precomputed legend index lookups (avoid repeated indexOf calls)
const IDX_NAMESPACE     = TOKEN_TYPES.indexOf('namespace');
const IDX_TYPE          = TOKEN_TYPES.indexOf('type');
const IDX_CLASS         = TOKEN_TYPES.indexOf('class');
const IDX_ENUM          = TOKEN_TYPES.indexOf('enum');
const IDX_INTERFACE     = TOKEN_TYPES.indexOf('interface');
const IDX_TYPE_PARAM    = TOKEN_TYPES.indexOf('typeParameter');
const IDX_PARAMETER     = TOKEN_TYPES.indexOf('parameter');
const IDX_VARIABLE      = TOKEN_TYPES.indexOf('variable');
const IDX_ENUM_MEMBER   = TOKEN_TYPES.indexOf('enumMember');
const IDX_PROPERTY      = TOKEN_TYPES.indexOf('property');
const IDX_FUNCTION      = TOKEN_TYPES.indexOf('function');
const IDX_METHOD        = TOKEN_TYPES.indexOf('method');

const MOD_DECLARATION   = 1 << TOKEN_MODIFIERS.indexOf('declaration');
const MOD_READONLY      = 1 << TOKEN_MODIFIERS.indexOf('readonly');
const MOD_STATIC        = 1 << TOKEN_MODIFIERS.indexOf('static');
const MOD_ASYNC         = 1 << TOKEN_MODIFIERS.indexOf('async');
const MOD_DEFAULT_LIB   = 1 << TOKEN_MODIFIERS.indexOf('defaultLibrary');

// ─────────────────────────────────────────────────────────────────────────────
// Decode a single TS TwentyTwenty encoded span into a legend type index and
// modifier bitmask.  Returns -1 for typeIdx to signal "skip this token".
// ─────────────────────────────────────────────────────────────────────────────
function decode(encoded: number): { typeIdx: number; modBits: number } {
    const tsType = encoded & 0xFF;
    const tsMods = (encoded >> 8) & 0xFF;

    // Build VS Code modifier bitmask
    let modBits = 0;
    if (tsMods & TS_MOD_DECLARATION) { modBits |= MOD_DECLARATION; }
    if (tsMods & TS_MOD_READONLY)    { modBits |= MOD_READONLY; }
    if (tsMods & TS_MOD_STATIC)      { modBits |= MOD_STATIC; }
    if (tsMods & TS_MOD_ASYNC)       { modBits |= MOD_ASYNC; }
    if (tsMods & TS_MOD_DEFAULT_LIB) { modBits |= MOD_DEFAULT_LIB; }

    const isDefaultLib   = (tsMods & TS_MOD_DEFAULT_LIB) !== 0;
    const isDeclaration  = (tsMods & TS_MOD_DECLARATION)  !== 0;

    switch (tsType) {
        case TS_TYPE_VARIABLE:
            // Only colour variables that are built-in browser globals
            // (window, document, console, etc. — all have defaultLibrary set).
            // Plain var/let/const locals and user-declared globals are left
            // uncoloured, matching VS Code's own JS behaviour.
            if (!isDefaultLib) { return { typeIdx: -1, modBits: 0 }; }
            return { typeIdx: IDX_VARIABLE, modBits };

        case TS_TYPE_PARAMETER:
            // Always colour parameters — this is what makes `textarea` in
            // `.forEach(textarea => ...)` get its own distinct colour.
            return { typeIdx: IDX_PARAMETER, modBits };

        case TS_TYPE_FUNCTION:
            // Skip declaration site of plain function declarations if desired —
            // but actually colouring them is useful (shows function names).
            return { typeIdx: IDX_FUNCTION, modBits };

        case TS_TYPE_METHOD:
            return { typeIdx: IDX_METHOD, modBits };

        case TS_TYPE_PROPERTY:
            return { typeIdx: IDX_PROPERTY, modBits };

        case TS_TYPE_CLASS:
            return { typeIdx: IDX_CLASS, modBits };

        case TS_TYPE_ENUM:
            return { typeIdx: IDX_ENUM, modBits };

        case TS_TYPE_ENUM_MEMBER:
            return { typeIdx: IDX_ENUM_MEMBER, modBits };

        case TS_TYPE_INTERFACE:
            return { typeIdx: IDX_INTERFACE, modBits };

        case TS_TYPE_NAMESPACE:
            return { typeIdx: IDX_NAMESPACE, modBits };

        case TS_TYPE_TYPE_PARAM:
            return { typeIdx: IDX_TYPE_PARAM, modBits };

        case TS_TYPE_TYPE:
            return { typeIdx: IDX_TYPE, modBits };

        default:
            return { typeIdx: -1, modBits: 0 };
    }
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
        const { virtualContent } = buildVirtualJsContent(content, 0);

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        const builder = new vscode.SemanticTokensBuilder(JS_SEMANTIC_LEGEND);

        const result = svc.getEncodedSemanticClassifications(
            0, virtualContent.length
        );

        // spans is a flat Int32Array of triples: [offset, length, encoded, ...]
        const spans = result.spans;
        for (let i = 0; i + 2 < spans.length; i += 3) {
            if (token.isCancellationRequested) { break; }

            const offset  = spans[i];
            const length  = spans[i + 1];
            const encoded = spans[i + 2];

            const { typeIdx, modBits } = decode(encoded);
            if (typeIdx === -1) { continue; }

            const pos = document.positionAt(offset);
            builder.push(pos.line, pos.character, length, typeIdx, modBits);
        }

        return builder.build();
    }
}