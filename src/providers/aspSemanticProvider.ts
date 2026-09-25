import * as vscode from 'vscode';
import { collectIncludeSymbols } from './includeProvider';
import { colourAspPage, SqlWarning } from '../utils/analysisClient';
// Use COMBINED_SEMANTIC_LEGEND from jsSemanticProvider — it now includes the
// SQL token types (indices 23–34) so all three providers (ASP, SQL, JS) share
// one identical legend. VS Code maps token indices through whichever legend is
// registered first; using a different legend here would corrupt all colours.
import { COMBINED_SEMANTIC_LEGEND } from './jsSemanticProvider';

/**
 * The VBScript and SQL colouring, and the SQL warnings.
 *
 * The work itself — several passes over the whole page, a few hundred
 * milliseconds after every edit on a large one — runs on a worker thread
 * (utils/aspColouring.ts), the way the JavaScript colouring does. On the
 * extension host it held up typing, completion and everything else while it
 * ran. What is left here is gathering the include symbols it needs, and turning
 * its answer back into tokens and squiggles.
 */
export class AspSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {

    private readonly _diagnostics: vscode.DiagnosticCollection;

    constructor() {
        this._diagnostics = vscode.languages.createDiagnosticCollection('asp-sql-vars');
    }

    dispose(): void {
        this._diagnostics.dispose();
    }

    async provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens | undefined> {

        if (token.isCancellationRequested) { return undefined; }

        const requestedVersion = document.version;
        const result = await colourAspPage(
            document.uri.toString(), document.getText(), document.uri.fsPath, collectIncludeSymbols(document),
        );

        // The document may have moved on while the worker was busy, and every
        // position in the answer is measured against text that no longer
        // exists. VS Code asks again after a change, so dropping it loses nothing.
        if (!result || token.isCancellationRequested || document.version !== requestedVersion) { return undefined; }

        this._diagnostics.set(document.uri, result.warnings.map(toDiagnostic));

        const builder = new vscode.SemanticTokensBuilder(COMBINED_SEMANTIC_LEGEND);
        const tokens  = result.tokens;
        for (let i = 0; i + 4 < tokens.length; i += 5) {
            builder.push(tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4]);
        }
        return builder.build();
    }
}

function toDiagnostic(warning: SqlWarning): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
            new vscode.Position(warning.line, warning.character),
            new vscode.Position(warning.line, warning.character + warning.length),
        ),
        warning.message,
        vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = 'ASP SQL';
    return diagnostic;
}
