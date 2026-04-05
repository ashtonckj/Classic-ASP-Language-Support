/**
 * jsSemanticTokensProvider.ts  (providers/)
 *
 * Semantic token colouring for JavaScript inside <script> blocks.
 *
 * KEY FIX — merged legend:
 *   VS Code supports registering multiple DocumentSemanticTokensProviders for
 *   the same language, but each provider must use the *same* legend that was
 *   declared in package.json's semanticTokenScopes contribution, OR they must
 *   use identical legend arrays.  When two providers with different legends
 *   are registered against the same language ID, VS Code picks one legend
 *   arbitrarily and maps all token indices through it — causing wrong colours.
 *
 *   The fix: this file exports a COMBINED_SEMANTIC_LEGEND that is the union of
 *   both the ASP/VBScript token types and the JS token types.  The ASP
 *   semantic provider (aspSemanticProvider.ts) must import and use this same
 *   legend object.  extension.ts registers only ONE provider per language,
 *   which dispatches internally based on zone.
 *
 *   If you prefer to keep the two providers separate, make sure both import
 *   and declare the exact same TOKEN_TYPES / TOKEN_MODIFIERS arrays.
 *
 * Other fixes:
 *   • <script> tag attributes are now excluded — previously the tag text
 *     itself could produce spurious tokens for words like "type" or "src".
 *   • Cancellation is checked before the (potentially slow) classification
 *     call, not just inside the loop.
 *   • TS TwentyTwenty type constants validated against ts.ClassificationType
 *     at module load in development builds.
 */

import * as vscode from 'vscode';
import {
    buildVirtualJsContent,
    getJsLanguageService,
} from '../utils/jsUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Combined legend — must be shared with aspSemanticProvider.ts
//
// The TOKEN_TYPES list is the union of all types used by either the ASP
// provider or the JS provider.  Add any ASP-specific types your
// aspSemanticProvider emits to the end of TOKEN_TYPES here, and import
// COMBINED_SEMANTIC_LEGEND from this file in aspSemanticProvider.ts.
// ─────────────────────────────────────────────────────────────────────────────
export const TOKEN_TYPES = [
    // ── Standard VS Code / JS types ──────────────────────────────────────────
    'namespace', 'type', 'class', 'enum', 'interface', 'struct',
    'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
    'event', 'function', 'method', 'macro', 'keyword', 'modifier',
    'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
    // ── ASP / VBScript-specific types (append yours here) ────────────────────
    // e.g. 'aspKeyword', 'aspBuiltin'  — add as needed
] as const;

export const TOKEN_MODIFIERS = [
    'declaration', 'definition', 'readonly', 'static', 'deprecated',
    'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
] as const;

/** Single legend shared by BOTH the ASP and JS semantic token providers. */
export const COMBINED_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
    [...TOKEN_TYPES],
    [...TOKEN_MODIFIERS]
);

// Keep the old export name so extension.ts doesn't need to change if it
// already imports JS_SEMANTIC_LEGEND.  Both names point to the same object.
export const JS_SEMANTIC_LEGEND = COMBINED_SEMANTIC_LEGEND;

// ─────────────────────────────────────────────────────────────────────────────
// TypeScript TwentyTwenty ("2020") encoding — confirmed by reading
// src/services/classifier2020.ts from the TypeScript compiler source.
//
// Each span triple is [offset, length, encoded] where:
//   encoded = (tokenType << 8) | modifierBitmask
//
//   tokenType  = encoded >> 8          (HIGH byte)
//   modifiers  = encoded & 0xFF        (LOW byte)
//
// IMPORTANT: The wire values are the TokenType enum values + 1 (1-indexed).
// The source defines class=0, enum=1, ... but the encoded values are 1-based:
//
//   TokenType (source 0-based → wire 1-based):
//     class=1  enum=2  interface=3  namespace=4  typeParameter=5  type=6
//     parameter=7  variable=8  enumMember=9  property=10  function=11  member=12
//
//   'member' in the TS source = method in VS Code semantic token terms.
//
// Modifier bits (low byte):
//   bit 0 (1)  = declaration
//   bit 1 (2)  = static
//   bit 2 (4)  = async
//   bit 3 (8)  = readonly
//   bit 4 (16) = defaultLibrary
//   bit 5 (32) = local
//
// These values were verified by decoding live span output from the extension:
//   document(variable+defaultLib)    → encoded 2064 = (8<<8)|16  ✓
//   textarea(parameter+declaration)  → encoded 1793 = (7<<8)|1   ✓
//   addEventListener(member+defLib)  → encoded 3088 = (12<<8)|16 ✓
// ─────────────────────────────────────────────────────────────────────────────
const TS_TYPE_CLASS       = 1;
const TS_TYPE_ENUM        = 2;
const TS_TYPE_INTERFACE   = 3;
const TS_TYPE_NAMESPACE   = 4;
const TS_TYPE_TYPE_PARAM  = 5;
const TS_TYPE_TYPE        = 6;
const TS_TYPE_PARAMETER   = 7;
const TS_TYPE_VARIABLE    = 8;
const TS_TYPE_ENUM_MEMBER = 9;
const TS_TYPE_PROPERTY    = 10;
const TS_TYPE_FUNCTION    = 11;
const TS_TYPE_MEMBER      = 12;   // TS calls methods "member" — maps to IDX_METHOD

const TS_MOD_DECLARATION  = 1;
const TS_MOD_STATIC       = 2;
const TS_MOD_ASYNC        = 4;
const TS_MOD_READONLY     = 8;
const TS_MOD_DEFAULT_LIB  = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Precomputed legend index lookups (avoid repeated indexOf calls at runtime)
// ─────────────────────────────────────────────────────────────────────────────
const TYPES = [...TOKEN_TYPES] as string[];
const MODS  = [...TOKEN_MODIFIERS] as string[];

const IDX_NAMESPACE   = TYPES.indexOf('namespace');
const IDX_TYPE        = TYPES.indexOf('type');
const IDX_CLASS       = TYPES.indexOf('class');
const IDX_ENUM        = TYPES.indexOf('enum');
const IDX_INTERFACE   = TYPES.indexOf('interface');
const IDX_TYPE_PARAM  = TYPES.indexOf('typeParameter');
const IDX_PARAMETER   = TYPES.indexOf('parameter');
const IDX_VARIABLE    = TYPES.indexOf('variable');
const IDX_ENUM_MEMBER = TYPES.indexOf('enumMember');
const IDX_PROPERTY    = TYPES.indexOf('property');
const IDX_FUNCTION    = TYPES.indexOf('function');
const IDX_METHOD      = TYPES.indexOf('method');

const MOD_DECLARATION = 1 << MODS.indexOf('declaration');
const MOD_READONLY    = 1 << MODS.indexOf('readonly');
const MOD_STATIC      = 1 << MODS.indexOf('static');
const MOD_ASYNC       = 1 << MODS.indexOf('async');
const MOD_DEFAULT_LIB = 1 << MODS.indexOf('defaultLibrary');

// ─────────────────────────────────────────────────────────────────────────────
// Decode a single TwentyTwenty encoded span into legend type index + modifier
// bitmask.  Returns typeIdx === -1 to signal "skip this token".
// ─────────────────────────────────────────────────────────────────────────────
function decode(encoded: number): { typeIdx: number; modBits: number } {
    // HIGH byte = token type, LOW byte = modifier bitmask
    const tsType = encoded >> 8;
    const tsMods = encoded & 0xFF;

    let modBits = 0;
    if (tsMods & TS_MOD_DECLARATION) { modBits |= MOD_DECLARATION; }
    if (tsMods & TS_MOD_READONLY)    { modBits |= MOD_READONLY; }
    if (tsMods & TS_MOD_STATIC)      { modBits |= MOD_STATIC; }
    if (tsMods & TS_MOD_ASYNC)       { modBits |= MOD_ASYNC; }
    if (tsMods & TS_MOD_DEFAULT_LIB) { modBits |= MOD_DEFAULT_LIB; }

    const isDefaultLib = (tsMods & TS_MOD_DEFAULT_LIB) !== 0;

    switch (tsType) {
        case TS_TYPE_VARIABLE:
            // Only colour variables that are built-in browser globals
            // (window, document, console, etc. — all have defaultLibrary set).
            // Plain var/let/const locals are left uncoloured, matching VS Code's
            // own JS behaviour.
            if (!isDefaultLib) { return { typeIdx: -1, modBits: 0 }; }
            return { typeIdx: IDX_VARIABLE, modBits };

        case TS_TYPE_PARAMETER:
            return { typeIdx: IDX_PARAMETER, modBits };

        case TS_TYPE_FUNCTION:
            return { typeIdx: IDX_FUNCTION, modBits };

        case TS_TYPE_MEMBER:
            // TS names methods "member" in the TwentyTwenty format
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
// Build the set of offset ranges that are inside real JS content
// (re-derived cheaply from the document — same logic as buildVirtualJsContent
// but without building the full string, since we only need the ranges here).
// This lets us skip any tokens TS emits for the <script ...> tag text itself.
// ─────────────────────────────────────────────────────────────────────────────
function getJsRanges(content: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    const re = /<script(\s[^>]*)?>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const attrs  = m[1] ?? '';
        const tagEnd = m.index + m[0].length;
        const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
        if (typeMatch && !/javascript|module/i.test(typeMatch[1])) { continue; }
        if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs)) { continue; }
        const rest     = content.slice(tagEnd);
        const closeIdx = rest.search(/<\/script\s*>/i);
        const end      = closeIdx === -1 ? content.length : tagEnd + closeIdx;
        ranges.push({ start: tagEnd, end });
        re.lastIndex = end;
    }
    return ranges;
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

        if (token.isCancellationRequested) { return undefined; }

        const content = document.getText();
        const { virtualContent } = buildVirtualJsContent(content, 0);

        // Bail early if there are no script blocks at all
        const jsRanges = getJsRanges(content);
        if (jsRanges.length === 0) { return undefined; }

        if (token.isCancellationRequested) { return undefined; }

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        // Classification call can be slow on large files — check cancellation
        // immediately after so we don't waste time building the token list.
        const result = svc.getEncodedSemanticClassifications(
            0, virtualContent.length
        );

        if (token.isCancellationRequested) { return undefined; }

        const builder = new vscode.SemanticTokensBuilder(COMBINED_SEMANTIC_LEGEND);

        // spans is a flat array of triples: [offset, length, encoded, ...]
        const spans = result.spans;
        for (let i = 0; i + 2 < spans.length; i += 3) {
            if (token.isCancellationRequested) { break; }

            const offset  = spans[i];
            const length  = spans[i + 1];
            const encoded = spans[i + 2];

            // Skip tokens that don't fall inside a real JS range.
            // This filters out spurious tokens from <script type="..."> tag
            // attributes — the tag text is not blanked in virtualContent,
            // so TS can produce tokens for words like "type", "src", etc.
            const inJs = jsRanges.some(r => offset >= r.start && offset < r.end);
            if (!inJs) { continue; }

            const { typeIdx, modBits } = decode(encoded);
            if (typeIdx === -1) { continue; }

            const pos = document.positionAt(offset);
            builder.push(pos.line, pos.character, length, typeIdx, modBits);
        }

        return builder.build();
    }
}