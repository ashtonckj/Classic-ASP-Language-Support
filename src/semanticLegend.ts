/**
 * semanticLegend.ts
 *
 * The one semantic token legend every provider uses: VBScript, SQL and
 * JavaScript. VS Code maps token type indices through whichever legend it sees
 * first for a language, so two legends would give one set of providers the
 * wrong colours.
 */

import * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────────────────────
// Combined legend
// ─────────────────────────────────────────────────────────────────────────────
export const TOKEN_TYPES = [
    // Standard VS Code token types — indices 0–22
    'namespace', 'type', 'class', 'enum', 'interface', 'struct',
    'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
    'event', 'function', 'method', 'macro', 'keyword', 'modifier',
    'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
    // ASP/SQL-specific token types — indices 23–34
    // Must match the numbering listed in vbscript/sqlTokens.ts exactly
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
