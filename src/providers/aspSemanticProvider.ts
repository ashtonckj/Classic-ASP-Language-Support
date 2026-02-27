import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import { isInsideAspBlock } from '../utils/documentHelper';

// ─────────────────────────────────────────────────────────────────────────────
// Semantic token legend — must match what is declared in package.json
// under contributes.semanticTokenScopes.
//
// Token types we provide:
//   "function" → user-defined Function names when called or declared
//   "namespace" → user-defined Sub names when called or declared
//
// We use the standard "function" type so VS Code themes colour it
// automatically without needing custom theme rules.
// ─────────────────────────────────────────────────────────────────────────────
export const ASP_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
    ['function', 'namespace'],   // token types
    ['declaration', 'readonly']  // token modifiers
);

export class AspSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {

    provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SemanticTokens> {

        const builder = new vscode.SemanticTokensBuilder(ASP_SEMANTIC_LEGEND);
        const text    = document.getText();

        // Collect all known function/sub names from this file + includes
        const allSymbols  = collectAllSymbols(document);
        const funcNames   = new Map<string, 'function' | 'namespace'>();

        for (const fn of allSymbols.functions) {
            funcNames.set(fn.name.toLowerCase(), fn.kind === 'Function' ? 'function' : 'namespace');
        }

        if (funcNames.size === 0) return builder.build();

        const lines = text.split('\n');

        lines.forEach((line, lineIndex) => {
            // Skip if not inside an ASP block
            const lineOffset = document.offsetAt(new vscode.Position(lineIndex, 0));
            if (!isInsideAspBlock(text, lineOffset + Math.floor(line.length / 2))) return;

            // Skip comment lines
            const trimmed = line.trimStart();
            if (trimmed.startsWith("'") || /^rem\s/i.test(trimmed)) return;

            // Find all word tokens in the line and check if they are known function/sub names.
            // We match whole words only, ignoring anything inside strings (quoted sections).
            // Strategy: strip string contents first, then scan for word matches.
            const strippedLine = line.replace(/"[^"]*"/g, m => ' '.repeat(m.length));

            const wordPattern = /\b([a-zA-Z_]\w*)\b/g;
            let match: RegExpExecArray | null;

            while ((match = wordPattern.exec(strippedLine)) !== null) {
                const word    = match[1];
                const wordKey = word.toLowerCase();

                if (!funcNames.has(wordKey)) continue;

                const kind     = funcNames.get(wordKey)!;
                const tokenType = kind === 'function' ? 0 : 1; // index into legend

                // Determine modifier:
                //   "declaration" if this is the Sub/Function definition line
                //   no modifier for call sites
                const isDeclaration = /^\s*(?:Public\s+|Private\s+)?(?:Function|Sub)\s+/i.test(line);
                const modifierMask  = isDeclaration ? 1 : 0; // 1 = "declaration" modifier

                builder.push(lineIndex, match.index, word.length, tokenType, modifierMask);
            }
        });

        return builder.build();
    }
}