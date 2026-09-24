/**
 * jsSemanticProvider.ts  (providers/)
 *
 * Semantic token colouring for JavaScript inside <script> blocks.
 *
 * COMBINED_SEMANTIC_LEGEND must be shared with aspSemanticProvider.ts.
 * VS Code maps token type indices through whichever legend it sees first for a
 * given language ID, so if two providers register with different legends the
 * colours for one of them will be wrong. Import COMBINED_SEMANTIC_LEGEND from
 * this file in aspSemanticProvider.ts and pass it to both registrations in
 * extension.ts.
 *
 * TwentyTwenty encoding (from src/services/classifier2020.ts in the TS source):
 *   encoded = (tokenType << 8) | modifierBitmask
 *   tokenType  = encoded >> 8   (1-indexed: class=1 … member=12)
 *   modifiers  = encoded & 0xFF (bit flags: declaration=1, defaultLibrary=16, …)
 *   'member' in the TS source corresponds to 'method' in VS Code's token types.
 *
 * FIX: preambleLength is now subtracted from every token offset before the
 * JS-range membership test and before calling document.positionAt. Previously,
 * all semantic tokens were painted at positions shifted forward by the preamble
 * size, miscolouring completely wrong regions of the editor.
 *
 * The classification runs on a worker thread (jsAnalysisWorker.ts); this file
 * only decodes what comes back. VS Code re-requests these tokens after every
 * edit, and on a large <script> the classification takes about a second, which
 * is not something the extension host can be doing while the user types.
 */

import * as vscode from 'vscode';
import { analyseEmbeddedJs } from '../utils/analysisClient';
import { inRanges } from '../utils/zoneUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Combined legend — shared with aspSemanticProvider.ts
// ─────────────────────────────────────────────────────────────────────────────
export const TOKEN_TYPES = [
    // Standard VS Code token types — indices 0–22
    'namespace', 'type', 'class', 'enum', 'interface', 'struct',
    'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
    'event', 'function', 'method', 'macro', 'keyword', 'modifier',
    'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
    // ASP/SQL-specific token types — indices 23–34
    // Must match the order declared in sqlSemanticProvider.ts exactly
    'sqlDml', 'sqlDdl', 'sqlLogical', 'sqlKeyword', 'sqlFunction', 'sqlType',
    'sqlVariable', 'sqlNumber', 'sqlBracketPunct', 'sqlBracketContent',
    'sqlTable', 'sqlColumn',
] as const;

export const TOKEN_MODIFIERS = [
    'declaration', 'definition', 'readonly', 'static', 'deprecated',
    'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
] as const;

export const COMBINED_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
    [...TOKEN_TYPES],
    [...TOKEN_MODIFIERS]
);

export const JS_SEMANTIC_LEGEND = COMBINED_SEMANTIC_LEGEND;

// ─────────────────────────────────────────────────────────────────────────────
// TwentyTwenty token type constants (1-indexed wire values)
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
const TS_TYPE_MEMBER      = 12;  // 'member' in TS source = method in VS Code

const TS_MOD_DECLARATION  = 1;
const TS_MOD_STATIC       = 2;
const TS_MOD_ASYNC        = 4;
const TS_MOD_READONLY     = 8;
const TS_MOD_DEFAULT_LIB  = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Precomputed legend index lookups
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
// Decode
// ─────────────────────────────────────────────────────────────────────────────
function decode(encoded: number): { typeIdx: number; modBits: number } {
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
            // Colour only built-in browser globals (window, document, console…).
            // Plain var/let/const locals are left uncoloured, matching VS Code's own JS behaviour.
            if (!isDefaultLib) { return { typeIdx: -1, modBits: 0 }; }
            return { typeIdx: IDX_VARIABLE, modBits };
        case TS_TYPE_PARAMETER:   return { typeIdx: IDX_PARAMETER,   modBits };
        case TS_TYPE_FUNCTION:    return { typeIdx: IDX_FUNCTION,     modBits };
        case TS_TYPE_MEMBER:      return { typeIdx: IDX_METHOD,       modBits };
        case TS_TYPE_PROPERTY:    return { typeIdx: IDX_PROPERTY,     modBits };
        case TS_TYPE_CLASS:       return { typeIdx: IDX_CLASS,        modBits };
        case TS_TYPE_ENUM:        return { typeIdx: IDX_ENUM,         modBits };
        case TS_TYPE_ENUM_MEMBER: return { typeIdx: IDX_ENUM_MEMBER,  modBits };
        case TS_TYPE_INTERFACE:   return { typeIdx: IDX_INTERFACE,    modBits };
        case TS_TYPE_NAMESPACE:   return { typeIdx: IDX_NAMESPACE,    modBits };
        case TS_TYPE_TYPE_PARAM:  return { typeIdx: IDX_TYPE_PARAM,   modBits };
        case TS_TYPE_TYPE:        return { typeIdx: IDX_TYPE,         modBits };
        default:                  return { typeIdx: -1,               modBits: 0 };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────
export class JsSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {

    async provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token:    vscode.CancellationToken
    ): Promise<vscode.SemanticTokens | undefined> {

        if (token.isCancellationRequested) { return undefined; }

        const fullText = document.getText();

        // Cheap enough to be worth doing before waking the worker: a page with
        // no <script> at all is the common case and needs no analysis.
        if (!/<script/i.test(fullText)) { return undefined; }

        // The classification runs on a worker thread. Everything TypeScript
        // does here is whole-file and lands on every edit, and the extension
        // host is also where auto-close, indenting and suggestions run — so it
        // cannot be the thread that spends a second type-checking.
        const requestedVersion = document.version;
        const analysis = await analyseEmbeddedJs(document.uri.toString(), fullText);

        if (!analysis || token.isCancellationRequested) { return undefined; }

        // The document may have moved on while the worker was busy. Every
        // offset below would then be measured against text that no longer
        // exists, so the tokens would be painted in the wrong places. VS Code
        // asks again after a change, so dropping this answer loses nothing.
        if (document.version !== requestedVersion) { return undefined; }

        const { spans, jsRanges, preambleLength } = analysis;
        if (jsRanges.length === 0) { return undefined; }

        const builder = new vscode.SemanticTokensBuilder(COMBINED_SEMANTIC_LEGEND);

        for (let i = 0; i + 2 < spans.length; i += 3) {
            if (token.isCancellationRequested) { break; }

            const virtualOffset = spans[i];
            const length        = spans[i + 1];
            const encoded       = spans[i + 2];

            // FIX: convert virtual-file offset → document offset by subtracting preambleLength.
            // Tokens that fall inside the preamble itself (virtualOffset < preambleLength) are
            // preamble-generated declarations — skip them, they have no counterpart in the source.
            const docOffset = virtualOffset - preambleLength;
            if (docOffset < 0) { continue; }

            // Inclusive at both ends so a token that abuts the closing </script>
            // tag is not dropped. Binary search rather than a scan: this runs
            // once per token, and a page can hold both many tokens and many
            // script blocks.
            if (!inRanges(jsRanges, docOffset, false)) { continue; }

            const { typeIdx, modBits } = decode(encoded);
            if (typeIdx === -1) { continue; }

            // FIX: use docOffset (document space) for positionAt, not the virtual offset.
            const pos = document.positionAt(docOffset);
            builder.push(pos.line, pos.character, length, typeIdx, modBits);
        }

        return builder.build();
    }
}