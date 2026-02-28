import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import { isInsideAspBlock } from '../utils/documentHelper';

// ─────────────────────────────────────────────────────────────────────────────
// Semantic token legend — must match contributes.semanticTokenScopes in package.json
//
// Token types (index order matters — must match the array below):
//   0  function   → user-defined Function names
//   1  namespace  → user-defined Sub names (reusing "namespace" as closest built-in type)
//   2  variable   → Dim'd variables and COM object variables (rs, conn, etc.)
//   3  parameter  → function/sub parameters inside their own function body
//   4  enumMember → Const values (enumMember is the standard type for named constants)
//
// Token modifiers:
//   0  declaration → the line where the symbol is defined/declared
//   1  readonly    → used on constants (they cannot be reassigned)
// ─────────────────────────────────────────────────────────────────────────────
export const ASP_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
    ['function', 'namespace', 'variable', 'parameter', 'enumMember'],
    ['declaration', 'readonly']
);

// Token type indices for readability
const T_FUNCTION  = 0;
const T_NAMESPACE = 1;
const T_VARIABLE  = 2;
const T_PARAMETER = 3;
const T_CONSTANT  = 4;

// Token modifier bit masks
const M_DECLARATION = 1;   // 1 << 0
const M_READONLY    = 2;   // 1 << 1

export class AspSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {

    provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SemanticTokens> {

        const builder    = new vscode.SemanticTokensBuilder(ASP_SEMANTIC_LEGEND);
        const text       = document.getText();
        const allSymbols = collectAllSymbols(document);

        // ── Build fast lookup sets / maps ─────────────────────────────────────

        // Function names → token type
        const funcMap = new Map<string, 'function' | 'Sub'>();
        for (const fn of allSymbols.functions) {
            funcMap.set(fn.name.toLowerCase(), fn.kind === 'Function' ? 'function' : 'Sub');
        }

        // Variable names (Dim'd)
        const varSet = new Set<string>();
        for (const v of allSymbols.variables) {
            varSet.add(v.name.toLowerCase());
        }

        // COM object variable names (rs, conn, dict, etc.)
        const comVarSet = new Set<string>();
        for (const cv of allSymbols.comVariables) {
            comVarSet.add(cv.name.toLowerCase());
        }

        // Constant names
        const constSet = new Set<string>();
        for (const c of allSymbols.constants) {
            constSet.add(c.name.toLowerCase());
        }

        // Parameter scoping:
        // Build a map of lineNumber → Set<paramName> for quick lookup.
        // Each param is only valid between its function's startLine and endLine.
        // We build a per-line param set by walking every line and checking which
        // functions "own" that line.
        //
        // Since functions in a file rarely exceed a few hundred lines each, and
        // files are usually not enormous, this is fast enough to do per-keystroke.
        const lineCount = document.lineCount;
        const lineParamSets: Map<number, Set<string>> = new Map();

        for (const fn of allSymbols.functions) {
            if (fn.paramNames.length === 0) continue;
            // Only scope params to the current document's functions (not includes)
            // — params from include files are not accessible in this doc anyway
            if (fn.filePath !== document.uri.fsPath) continue;

            const start = fn.line;
            const end   = fn.endLine !== -1 ? fn.endLine : lineCount - 1;

            for (let l = start; l <= end; l++) {
                if (!lineParamSets.has(l)) lineParamSets.set(l, new Set());
                for (const p of fn.paramNames) {
                    lineParamSets.get(l)!.add(p.toLowerCase());
                }
            }
        }

        // ── Scan each line ────────────────────────────────────────────────────
        const lines = text.split('\n');

        lines.forEach((line, lineIndex) => {
            // Skip lines not inside an ASP block
            const lineOffset = document.offsetAt(new vscode.Position(lineIndex, 0));
            const midOffset  = lineOffset + Math.floor(line.length / 2);
            if (!isInsideAspBlock(text, midOffset)) return;

            // Skip comment lines
            const trimmed = line.trimStart();
            if (trimmed.startsWith("'") || /^rem\s/i.test(trimmed)) return;

            // Strip string contents so we don't highlight words inside strings
            const strippedLine = line.replace(/"[^"]*"/g, (m: string) => ' '.repeat(m.length));

            // Get the params active on this line (if any)
            const activeParams = lineParamSets.get(lineIndex);

            // Detect context flags for this line
            const isFuncDeclaration = /^\s*(?:Public\s+|Private\s+)?(?:Function|Sub)\s+/i.test(line);
            const isDimLine         = /^\s*(?:Dim|ReDim|Public|Private)\s+/i.test(line);
            const isConstLine       = /^\s*(?:Public\s+|Private\s+)?Const\s+/i.test(line);
            const isSetLine         = /^\s*Set\s+\w+\s*=/i.test(line);

            // Scan all word tokens in the stripped line
            const wordPattern = /\b([a-zA-Z_]\w*)\b/g;
            let match: RegExpExecArray | null;

            while ((match = wordPattern.exec(strippedLine)) !== null) {
                const word    = match[1];
                const wordKey = word.toLowerCase();
                const col     = match.index;

                // ── Skip VBScript keywords so we don't double-colour them ────
                if (VBSCRIPT_KEYWORDS.has(wordKey)) continue;

                // ── Function / Sub names ──────────────────────────────────────
                if (funcMap.has(wordKey)) {
                    const kind         = funcMap.get(wordKey)!;
                    const tokenType    = kind === 'function' ? T_FUNCTION : T_NAMESPACE;
                    const modifierMask = isFuncDeclaration && word === line.match(/(?:Function|Sub)\s+(\w+)/i)?.[1]
                        ? M_DECLARATION
                        : 0;
                    builder.push(lineIndex, col, word.length, tokenType, modifierMask);
                    continue;
                }

                // ── Parameters (scoped to their function body) ────────────────
                if (activeParams?.has(wordKey)) {
                    // On the declaration line the param name is a declaration
                    const modifierMask = isFuncDeclaration ? M_DECLARATION : 0;
                    builder.push(lineIndex, col, word.length, T_PARAMETER, modifierMask);
                    continue;
                }

                // ── Constants ─────────────────────────────────────────────────
                if (constSet.has(wordKey)) {
                    const modifierMask = isConstLine
                        ? M_DECLARATION | M_READONLY
                        : M_READONLY;
                    builder.push(lineIndex, col, word.length, T_CONSTANT, modifierMask);
                    continue;
                }

                // ── COM object variables (rs, conn, dict, etc.) ───────────────
                if (comVarSet.has(wordKey)) {
                    // On a Set line the first word after Set is the declaration
                    const modifierMask = isSetLine ? M_DECLARATION : 0;
                    builder.push(lineIndex, col, word.length, T_VARIABLE, modifierMask);
                    continue;
                }

                // ── Regular Dim'd variables ───────────────────────────────────
                if (varSet.has(wordKey)) {
                    const modifierMask = isDimLine ? M_DECLARATION : 0;
                    builder.push(lineIndex, col, word.length, T_VARIABLE, modifierMask);
                    continue;
                }
            }
        });

        return builder.build();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// VBScript keywords to skip — we never colour these as variables/functions
// even if someone shadowed a keyword with a variable name (bad practice but possible)
// ─────────────────────────────────────────────────────────────────────────────
const VBSCRIPT_KEYWORDS = new Set([
    'dim','redim','set','let','get','const','call','new',
    'if','then','else','elseif','end','select','case',
    'for','each','in','to','step','next',
    'while','wend','do','loop','until',
    'function','sub','class','property',
    'private','public','default',
    'and','or','not','xor','eqv','imp','is','mod',
    'true','false','null','nothing','empty',
    'with','exit','return','goto','on','error','resume',
    'option','explicit','randomize',
    'response','request','server','session','application',
]);