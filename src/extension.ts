import * as vscode from 'vscode';
import { registerAspFeatures } from './asp/aspFeatures';
import { registerHtmlFeatures } from './html/htmlFeatures';
import { registerCssFeatures } from './css/cssFeatures';
import { registerJsFeatures } from './js/jsFeatures';
import { registerSemanticTokens } from './semanticTokens';
import { registerFormatting } from './formatter/formatCommands';
import { registerAutoClosingTag } from './asp/typing/autoClose';
import { registerEnterKeyHandler } from './asp/typing/enterKey';
import { registerTabKeyHandler } from './asp/typing/tabKey';
import { registerVbScriptQuoteGuard } from './asp/typing/quoteGuard';
import { registerLineContinuationGuard } from './asp/typing/continuationGuard';
import { registerAspBlockMatch } from './asp/aspBlockMatchProvider';
import { registerAspStructureDiagnostics } from './asp/aspStructureDiagnosticsProvider';
import { registerHtmlStructureDiagnostics } from './html/htmlStructureDiagnosticsProvider';
import { registerCssDiagnostics } from './css/cssDiagnosticsProvider';
import { registerJsDiagnostics } from './js/jsDiagnosticsProvider';
import { addRegionHighlights } from './asp/highlight';
import { disposeIncludeWatchers } from './asp/includeProvider';
import { disposeWorkspaceIndex } from './asp/aspWorkspaceSymbolProvider';
import { disposeJsLanguageService } from './js/jsUtils';
import { disposeAnalysisWorkers } from './workers/analysisClient';
import { migrateOldSettingsAndTell } from './platform/settingsMigration';
import { checkForCompetingExtensions } from './platform/competingExtensions';
import { ReviewPrompt } from './platform/reviewPrompt';
import { disposeLog, log } from './platform/log';

// Wiring only: each feature registers its own providers and listeners and
// pushes their disposables onto the context, so everything is released when
// the extension deactivates.
export function activate(context: vscode.ExtensionContext) {
    log.info('Classic ASP Language Support is now active.');

    // Settings kept under their pre-0.7.0 names move to the new ones.
    void migrateOldSettingsAndTell(context);

    // Another Classic ASP extension fights this one over the colours.
    if (context.extensionMode !== vscode.ExtensionMode.Test) {
        void checkForCompetingExtensions(context);
    }

    // ── Problems and highlights ───────────────────────────────────────────────
    addRegionHighlights(context);
    registerCssDiagnostics(context);
    registerJsDiagnostics(context);
    const htmlStructure = registerHtmlStructureDiagnostics(context);
    const aspStructure  = registerAspStructureDiagnostics(context);
    registerAspBlockMatch(context);

    // ── Format Document, Format Selection, Preview Formatting ─────────────────
    registerFormatting(context, { htmlStructure, aspStructure, reviewPrompt: new ReviewPrompt(context) });

    // ── Language features ─────────────────────────────────────────────────────
    registerHtmlFeatures(context);
    registerAspFeatures(context);
    registerCssFeatures(context);
    registerJsFeatures(context);
    registerSemanticTokens(context);

    // ── Typing ────────────────────────────────────────────────────────────────
    registerAutoClosingTag(context);
    registerEnterKeyHandler(context);
    registerTabKeyHandler(context);
    registerVbScriptQuoteGuard(context);
    registerLineContinuationGuard(context);
}

export function deactivate(): void {
    disposeJsLanguageService();
    disposeAnalysisWorkers();
    disposeIncludeWatchers();
    disposeWorkspaceIndex();
    disposeLog();
}
