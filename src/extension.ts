import * as vscode from 'vscode';
import { formatCompleteAspFile } from './formatter/htmlFormatter';
import { HtmlCompletionProvider } from './html/htmlCompletionProvider';
import { registerAutoClosingTag } from './asp/typing/autoClose';
import { registerEnterKeyHandler } from './asp/typing/enterKey';
import { registerTabKeyHandler } from './asp/typing/tabKey';
import { registerVbScriptQuoteGuard } from './asp/typing/quoteGuard';
import { registerLineContinuationGuard } from './asp/typing/continuationGuard';
import { AspCompletionProvider } from './asp/aspCompletionProvider';
import { CssCompletionProvider } from './css/cssCompletionProvider';
import { EmmetCompletionProvider } from './html/emmetCompletionProvider';
import { CssHoverProvider } from './css/cssHoverProvider';
import { CssColorProvider } from './css/cssColorProvider';
import { registerCssDiagnostics } from './css/cssDiagnosticsProvider';
import { registerHtmlStructureDiagnostics, scanHtmlStructure, VoidElementQuickFixProvider } from './html/htmlStructureDiagnosticsProvider';
import { registerAspStructureDiagnostics, scanAspStructure, scanAspTags } from './asp/aspStructureDiagnosticsProvider';
import { registerAspBlockMatch } from './asp/aspBlockMatchProvider';
import { JsCompletionProvider } from './js/jsCompletionProvider';
import { JsHoverProvider } from './js/jsHoverProvider';
import { JsSignatureHelpProvider } from './js/jsSignatureHelpProvider';
// One legend for the JS, VBScript and SQL colouring: VS Code reads every
// provider's token numbers through the first legend registered.
import { JsSemanticTokensProvider, COMBINED_SEMANTIC_LEGEND } from './js/jsSemanticProvider';
import { registerJsDiagnostics } from './js/jsDiagnosticsProvider';
import { disposeJsLanguageService } from './js/jsUtils';
import { disposeIncludeWatchers, forgetIncludeFile, IncludePathCompletionProvider, preloadIncludeSymbols } from './asp/includeProvider';
import { AspDefinitionProvider } from './asp/aspDefinitionProvider';
import { IncludeDocumentLinkProvider, HtmlAttributeLinkProvider, HtmlAttributePathCompletionProvider } from './html/linkProvider';
import { AspSemanticTokensProvider } from './asp/aspSemanticProvider';
import { AspHoverProvider } from './asp/aspHoverProvider';
import { HtmlHoverProvider, HtmlLinkedEditingProvider } from './html/htmlLanguageFeatures';
import { AspReferenceProvider, AspRenameProvider, registerIncludeUpdatesOnRename } from './asp/aspRenameProvider';
import { addRegionHighlights } from './asp/highlight';
import { AspDocumentSymbolProvider } from './asp/aspDocumentSymbolProvider';
import { JsDocumentSymbolProvider } from './js/jsDocumentSymbolProvider';
import { JsCodeActionProvider } from './js/jsCodeActionProvider';
import { JsDefinitionProvider } from './js/jsDefinitionProvider';
import { JsReferenceProvider, JsDocumentHighlightProvider } from './js/jsReferenceProvider';
import { JsRenameProvider } from './js/jsRenameProvider';
import { disposeAnalysisWorkers } from './workers/analysisClient';
import { migrateOldSettingsAndTell } from './platform/settingsMigration';
import { checkForCompetingExtensions } from './platform/competingExtensions';
import { ReviewPrompt } from './platform/reviewPrompt';
import { AspWorkspaceSymbolProvider, clearWorkspaceSymbolCache, disposeWorkspaceIndex } from './asp/aspWorkspaceSymbolProvider';
import { AspSignatureHelpProvider } from './asp/aspSignatureHelpProvider';
import { computeLineEdits, computeRangeEdits, resolveEol, toLf } from './platform/editUtils';
import { prettierSettings } from './platform/settings';
import { disposeLog, log } from './platform/log';
import { guarded } from './platform/guardedProvider';

// Shared structure issue check used by both the formatter and the preview.
//
// The scans are re-run here rather than read back from the diagnostic
// collections. Those are filled by a 1500 ms debounced pass, so reading them
// answered from whatever the last tick happened to hold: a file opened and
// formatted inside the debounce window was formatted even though it was broken,
// and a file whose last problem had just been fixed was still refused, quoting
// an issue that no longer existed. Both collections are refreshed with the
// result so the squiggles agree with the answer given here.
function getStructureIssueCount(
    document: vscode.TextDocument,
    htmlCollection: vscode.DiagnosticCollection,
    aspCollection:  vscode.DiagnosticCollection
): number {
    const htmlIssues = scanHtmlStructure(document);
    const aspIssues  = [...scanAspTags(document), ...scanAspStructure(document)];

    htmlCollection.set(document.uri, htmlIssues);
    aspCollection.set(document.uri,  aspIssues);

    return htmlIssues.length + aspIssues.length;
}

// Opens VS Code's built-in diff editor showing current vs formatted.
// Nothing is applied to the real file — purely a visual preview.
async function openFormattingPreview(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    formatted: string
): Promise<void> {
    const previewUri   = document.uri.with({ scheme: 'asp-format-preview' });
    const provider     = new (class implements vscode.TextDocumentContentProvider {
        provideTextDocumentContent() { return formatted; }
    })();
    const registration = vscode.workspace.registerTextDocumentContentProvider('asp-format-preview', provider);

    await vscode.commands.executeCommand(
        'vscode.diff',
        document.uri,
        previewUri,
        `Formatting Preview — ${document.fileName.split(/[\\/]/).pop()}`,
        { preview: true }
    );

    const listener = vscode.window.onDidChangeVisibleTextEditors(() => {
        const still = vscode.window.visibleTextEditors.some(
            e => e.document.uri.toString() === previewUri.toString()
        );
        if (!still) { registration.dispose(); listener.dispose(); }
    });

    context.subscriptions.push(registration, listener);
}

// Module-level debounce handles — prevents queuing multiple triggerSuggest
// calls when the user moves the cursor or types faster than the 50 ms delay.
let _styleTimeout:   ReturnType<typeof setTimeout> | undefined;
let _attrPathTimeout: ReturnType<typeof setTimeout> | undefined;

function preloadIncludes(document: vscode.TextDocument | undefined): void {
    if (document?.languageId === 'asp') {
        void preloadIncludeSymbols(document);
    }
}

export function activate(context: vscode.ExtensionContext) {
    log.info('Classic ASP Language Support is now active.');

    // Settings kept under their pre-0.7.0 names move to the new ones.
    void migrateOldSettingsAndTell(context);

    // Another Classic ASP extension fights this one over the colours.
    if (context.extensionMode !== vscode.ExtensionMode.Test) {
        void checkForCompetingExtensions(context);
    }

    preloadIncludes(vscode.window.activeTextEditor?.document);
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(preloadIncludes),
        vscode.window.onDidChangeActiveTextEditor(editor => preloadIncludes(editor?.document)),
    );

    addRegionHighlights(context);
    registerCssDiagnostics(context);
    registerJsDiagnostics(context);
    const htmlStructureCollection = registerHtmlStructureDiagnostics(context);
    const aspStructureCollection  = registerAspStructureDiagnostics(context);

    // Asks for a rating, rarely, after a format that worked.
    const reviewPrompt = new ReviewPrompt(context);

    // ── Formatter ─────────────────────────────────────────────────────────────
    // The page as it is and as formatting would leave it — or undefined, with
    // the user told why, when a structure problem means it cannot be formatted.
    // Both are LF-normalised, so a CRLF-saved file is not reported as "every line
    // changed"; the edits are written back with the line ending resolveEol picks.
    async function formatForDocument(
        document: vscode.TextDocument,
    ): Promise<{ fullText: string; formatted: string } | undefined> {
        const total = getStructureIssueCount(document, htmlStructureCollection, aspStructureCollection);
        if (total > 0) {
            vscode.window.showWarningMessage(
                `Formatting skipped — ${total} structure issue${total === 1 ? '' : 's'} found. ` +
                `Fix the highlighted warnings first.`,
                'Show Problems'
            ).then(choice => {
                if (choice === 'Show Problems') {
                    vscode.commands.executeCommand('workbench.actions.view.problems');
                }
            });
            return undefined;
        }

        const fullText  = toLf(document.getText());
        const formatted = toLf(await formatCompleteAspFile(fullText));
        void reviewPrompt.formatted();
        return { fullText, formatted };
    }

    const formatter = vscode.languages.registerDocumentFormattingEditProvider('asp', guarded('Format Document', {
        async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
            const result = await formatForDocument(document);
            if (!result) { return []; }

            const eol = resolveEol(prettierSettings().endOfLine, document);
            return computeLineEdits(document, result.fullText, result.formatted, eol);
        }
    }));

    // ── Format Selection (Ctrl+K Ctrl+F) ──────────────────────────────────────
    // What Format Document would do, kept to the selected lines; see
    // computeRangeEdits for why the whole page is formatted to get it.
    const rangeFormatter = vscode.languages.registerDocumentRangeFormattingEditProvider('asp', guarded('Format Selection', {
        async provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.TextEdit[]> {
            const result = await formatForDocument(document);
            if (!result) { return []; }

            const eol = resolveEol(prettierSettings().endOfLine, document);
            const edits = computeRangeEdits(document, result.fullText, result.formatted, eol, range);
            if (!edits) {
                vscode.window.showInformationMessage(
                    'Formatting changes too much of this page to format just the selection — use Format Document.',
                );
                return [];
            }
            return edits;
        }
    }));

    // ── Classic ASP: Preview Formatting ───────────────────────────────────────
    // A diff of what Format Document would change, with nothing applied. This
    // was the formatPreview setting, which turned Format Document itself into a
    // preview until the setting was switched off again.
    const previewFormatting = vscode.commands.registerCommand('classicAsp.previewFormatting', async () => {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || document.languageId !== 'asp') { return; }

        const result = await formatForDocument(document);
        if (!result) { return; }
        if (result.formatted === result.fullText) {
            vscode.window.showInformationMessage('No formatting changes — file is already formatted.');
            return;
        }
        await openFormattingPreview(context, document, result.formatted);
    });

    // ── Completion providers ──────────────────────────────────────────────────
    const htmlCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', guarded('HtmlCompletionProvider', new HtmlCompletionProvider()), '<', '/', ' ', '='
    );

    const aspCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', guarded('AspCompletionProvider', new AspCompletionProvider()), '.', ' '
    );

    // Trigger chars are limited to punctuation that genuinely starts or
    // continues a CSS token.  The a-z letters are intentionally removed —
    // the zone check inside CssCompletionProvider already guards every call, so
    // VS Code's word-based activation is enough to keep completions flowing
    // while the user is typing a property or value name.  Keeping letter
    // triggers caused the provider to be invoked on every keystroke anywhere
    // in the file, not just inside CSS zones.
    const cssCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', guarded('CssCompletionProvider', new CssCompletionProvider()),
        ':', ';', '-', ' ', '{', '('
    );

    // JS completions — '.' triggers member access completions; '(' triggers
    // completions after a function name is typed.  Letter/digit triggers are
    // intentionally omitted — VS Code's built-in word-based filter handles
    // filtering the returned list as the user continues typing, and
    // isIncomplete:false tells it the list is already complete.
    const jsCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', guarded('JsCompletionProvider', new JsCompletionProvider()),
        '.', '('
    );

    // Emmet abbreviations. Registered here rather than through
    // `emmet.includeLanguages`, because that mapping applies to the whole
    // language and would offer markup inside <% %> — see the provider for what
    // Emmet's own guard does and does not catch.
    const emmetCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', guarded('EmmetCompletionProvider', new EmmetCompletionProvider()),
        '!', '.', '}', ':', '*', '$', ']', '/', '>', '-',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    );

    const includePathProvider = vscode.languages.registerCompletionItemProvider(
        'asp', guarded('IncludePathCompletionProvider', new IncludePathCompletionProvider()),
        '"', "'", '/', '\\', '.',
        'a','b','c','d','e','f','g','h','i','j','k','l','m',
        'n','o','p','q','r','s','t','u','v','w','x','y','z',
        'A','B','C','D','E','F','G','H','I','J','K','L','M',
        'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
        '0','1','2','3','4','5','6','7','8','9','_','-'
    );

    // ── Document link providers ───────────────────────────────────────────────
    const includeDocumentLinkProvider = vscode.languages.registerDocumentLinkProvider(
        'asp', guarded('IncludeDocumentLinkProvider', new IncludeDocumentLinkProvider())
    );

    const htmlAttributeLinkProvider = vscode.languages.registerDocumentLinkProvider(
        'asp', guarded('HtmlAttributeLinkProvider', new HtmlAttributeLinkProvider())
    );

    const htmlAttributePathProvider = vscode.languages.registerCompletionItemProvider(
        'asp', guarded('HtmlAttributePathCompletionProvider', new HtmlAttributePathCompletionProvider()),
        '"', "'", '/', '\\', '.',
        'a','b','c','d','e','f','g','h','i','j','k','l','m',
        'n','o','p','q','r','s','t','u','v','w','x','y','z',
        'A','B','C','D','E','F','G','H','I','J','K','L','M',
        'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
        '0','1','2','3','4','5','6','7','8','9','_','-'
    );

    // ── Colour swatches and picker ────────────────────────────────────────────
    // A .css or .html file shows a square beside every colour and opens a picker
    // on click; an ASP page showed nothing, in <style> blocks or style="" alike.
    const cssColorProvider = vscode.languages.registerColorProvider(
        'asp', guarded('CssColorProvider', new CssColorProvider())
    );

    // ── Go To Definition ──────────────────────────────────────────────────────
    // Two providers, each declining the other's zone: the ASP one resolves
    // VBScript names and #include paths, the JS one symbols in <script> blocks.
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        'asp', guarded('AspDefinitionProvider', new AspDefinitionProvider())
    );

    const jsDefinitionProvider = vscode.languages.registerDefinitionProvider(
        'asp', guarded('JsDefinitionProvider', new JsDefinitionProvider())
    );

    // ── References and occurrence highlighting ────────────────────────────────
    // Without these VS Code matches the word as plain TEXT, so a `total` inside
    // a string or a comment highlights as though it were the variable.
    const referenceProvider = vscode.languages.registerReferenceProvider(
        'asp', guarded('AspReferenceProvider', new AspReferenceProvider())
    );

    const jsReferenceProvider = vscode.languages.registerReferenceProvider(
        'asp', guarded('JsReferenceProvider', new JsReferenceProvider())
    );

    const jsDocumentHighlightProvider = vscode.languages.registerDocumentHighlightProvider(
        'asp', guarded('JsDocumentHighlightProvider', new JsDocumentHighlightProvider())
    );

    // ── Rename ────────────────────────────────────────────────────────────────
    const renameProvider = vscode.languages.registerRenameProvider(
        'asp', guarded('AspRenameProvider', new AspRenameProvider(), { userErrors: ['prepareRename', 'provideRenameEdits'] })
    );

    const jsRenameProvider = vscode.languages.registerRenameProvider(
        'asp', guarded('JsRenameProvider', new JsRenameProvider(), { userErrors: ['prepareRename', 'provideRenameEdits'] })
    );

    // ── Document symbols ─────────────────────────────────────────────────────
    const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
        'asp', guarded('AspDocumentSymbolProvider', new AspDocumentSymbolProvider())
    );

    const jsDocumentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
        'asp', guarded('JsDocumentSymbolProvider', new JsDocumentSymbolProvider())
    );

    // ── Signature help ───────────────────────────────────────────────────────
    const aspSignatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
        'asp',
        guarded('AspSignatureHelpProvider', new AspSignatureHelpProvider()),
        { triggerCharacters: ['('], retriggerCharacters: [','] }
    );

    const jsSignatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
        'asp',
        guarded('JsSignatureHelpProvider', new JsSignatureHelpProvider()),
        { triggerCharacters: ['('], retriggerCharacters: [','] }
    );

    // ── Workspace symbol search (Ctrl+T) ─────────────────────────────────────
    const workspaceSymbolProvider = vscode.languages.registerWorkspaceSymbolProvider(
        guarded('AspWorkspaceSymbolProvider', new AspWorkspaceSymbolProvider())
    );

    // languageId, not the file extension: the document is open, so VS Code has
    // already classified it — including through the user's own files.associations.
    // Matching /\.(asp|inc)$/ meant a Classic ASP library kept in a .html file
    // never invalidated either cache on save, so edits to it stayed invisible
    // until the window was reloaded.
    const wsCacheInvalidator = vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'asp') {
            clearWorkspaceSymbolCache(doc.uri.fsPath);
            forgetIncludeFile(doc.uri.fsPath);
        }
    });

    // ── Semantic tokens ───────────────────────────────────────────────────────
    // IMPORTANT: VS Code only honours ONE DocumentSemanticTokensProvider per
    // language. Registering two (ASP + JS) meant whichever ran second silently
    // discarded the other's tokens. The fix is a single combined provider that
    // runs both sub-providers and merges their delta-encoded token streams.
    // Both sub-providers already share COMBINED_SEMANTIC_LEGEND so all indices
    // and colours are always consistent.
    const aspSemanticProviderInstance = guarded('AspSemanticTokensProvider', new AspSemanticTokensProvider());
    const jsSemanticProviderInstance  = guarded('JsSemanticTokensProvider', new JsSemanticTokensProvider());
    context.subscriptions.push(aspSemanticProviderInstance);

    // Decode delta-encoded SemanticTokens data back to absolute positions.
    function decodeSemanticTokenData(data: Uint32Array): Array<[number, number, number, number, number]> {
        const tokens: Array<[number, number, number, number, number]> = [];
        let line = 0, char = 0;
        for (let i = 0; i + 4 < data.length; i += 5) {
            const deltaLine = data[i];
            const deltaChar = data[i + 1];
            const len  = data[i + 2];
            const type = data[i + 3];
            const mod  = data[i + 4];
            if (deltaLine > 0) { line += deltaLine; char  = deltaChar; }
            else               { char += deltaChar; }
            tokens.push([line, char, len, type, mod]);
        }
        return tokens;
    }

    const combinedSemanticProvider = vscode.languages.registerDocumentSemanticTokensProvider(
        'asp',
        guarded('Semantic tokens', {
            provideDocumentSemanticTokens(
                document: vscode.TextDocument,
                token:    vscode.CancellationToken
            ): vscode.ProviderResult<vscode.SemanticTokens> {
                const toPromise = (r: vscode.ProviderResult<vscode.SemanticTokens>) =>
                    r instanceof Promise ? r : Promise.resolve(r ?? undefined);

                return Promise.all([
                    toPromise(aspSemanticProviderInstance.provideDocumentSemanticTokens(document, token)),
                    toPromise(jsSemanticProviderInstance.provideDocumentSemanticTokens(document, token)),
                ]).then(([aspTokens, jsTokens]) => {
                    if (!aspTokens && !jsTokens) { return undefined; }
                    if (!aspTokens) { return jsTokens; }
                    if (!jsTokens)  { return aspTokens; }

                    // Merge both token streams, sort by position, rebuild
                    const all: Array<[number, number, number, number, number]> = [
                        ...decodeSemanticTokenData(aspTokens.data),
                        ...decodeSemanticTokenData(jsTokens.data),
                    ];
                    all.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);

                    const builder = new vscode.SemanticTokensBuilder(COMBINED_SEMANTIC_LEGEND);
                    for (const [l, c, len, type, mod] of all) {
                        builder.push(l, c, len, type, mod);
                    }
                    return builder.build();
                });
            }
        }),
        COMBINED_SEMANTIC_LEGEND
    );

    // ── Void element quick fix ─────────────────────────────────────────────────
    const voidElementQuickFix = vscode.languages.registerCodeActionsProvider(
        'asp', guarded('VoidElementQuickFixProvider', new VoidElementQuickFixProvider()),
        { providedCodeActionKinds: VoidElementQuickFixProvider.providedCodeActionKinds }
    );

    // Turns the JS squiggles into something actionable — a misspelt DOM member
    // reports "Did you mean 'getElementById'?", and TypeScript supplies the edit.
    const jsQuickFix = vscode.languages.registerCodeActionsProvider(
        'asp', guarded('JsCodeActionProvider', new JsCodeActionProvider()),
        { providedCodeActionKinds: JsCodeActionProvider.providedCodeActionKinds }
    );

    // ── Hover providers ───────────────────────────────────────────────────────
    const aspHoverProvider = vscode.languages.registerHoverProvider(
        'asp', guarded('AspHoverProvider', new AspHoverProvider())
    );

    const cssHoverProvider = vscode.languages.registerHoverProvider(
        'asp', guarded('CssHoverProvider', new CssHoverProvider())
    );

    const jsHoverProvider = vscode.languages.registerHoverProvider(
        'asp', guarded('JsHoverProvider', new JsHoverProvider())
    );

    const htmlHoverProvider = vscode.languages.registerHoverProvider(
        'asp', guarded('HtmlHoverProvider', new HtmlHoverProvider())
    );

    // ── Linked editing of a tag pair ──────────────────────────────────────────
    // VS Code's own feature, as in a .html file: it runs only when the user
    // turns on editor.linkedEditing. Start Linked Editing (Ctrl+Shift+F2)
    // without the setting marks the pair but does not mirror the typing, in a
    // .html file too.
    const htmlLinkedEditingProvider = vscode.languages.registerLinkedEditingRangeProvider(
        'asp', guarded('HtmlLinkedEditingProvider', new HtmlLinkedEditingProvider())
    );

    // ── Key handlers ──────────────────────────────────────────────────────────
    registerAutoClosingTag(context);
    registerEnterKeyHandler(context);
    registerTabKeyHandler(context);
    registerVbScriptQuoteGuard(context);
    registerLineContinuationGuard(context);
    registerAspBlockMatch(context);

    // ── Auto-trigger CSS suggestions inside empty style="" ────────────────────
    const inlineStyleTrigger = vscode.window.onDidChangeTextEditorSelection(e => {
        const editor = e.textEditor;
        const doc    = editor.document;
        if (doc.languageId !== 'asp') return;
        if (e.selections.length !== 1 || !e.selections[0].isEmpty) return;

        // Only the text around the caret is read: this runs on every cursor
        // move, and asking for the whole page made the editor copy all of it.
        const caret       = e.selections[0].active;
        const offset      = doc.offsetAt(caret);
        const searchStart = Math.max(0, offset - 200);
        const before      = doc.getText(new vscode.Range(doc.positionAt(searchStart), caret));
        const match       = before.match(/style\s*=\s*(["'])([\s\S]*)$/i);
        if (!match) return;

        const valueStart = searchStart + match.index! + match[0].length - match[2].length;
        const next       = doc.getText(new vscode.Range(caret, doc.positionAt(offset + 1)));
        if (next === match[1] && offset === valueStart) {
            clearTimeout(_styleTimeout);
            _styleTimeout = setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 50);
        }
    });

    // ── Auto-trigger path suggestions inside href/src/action/data-src ─────────
    const htmlAttrPathTrigger = vscode.workspace.onDidChangeTextDocument(e => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== e.document) return;
        if (e.document.languageId !== 'asp') return;
        if (e.contentChanges.length === 0) return;

        const change   = e.contentChanges[0];
        const position = change.range.start;
        const lineText = e.document.lineAt(position.line).text;

        if (change.text.length !== 1) return;

        const textBefore = lineText.substring(0, position.character + 1);
        const attrPattern = /\b(href|src|action|data-src)\s*=\s*["'][^"']*$/i;
        if (!attrPattern.test(textBefore)) return;

        clearTimeout(_attrPathTimeout);
        _attrPathTimeout = setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 50);
    });

    // ── Subscriptions ─────────────────────────────────────────────────────────
    // Rules:
    //   • Push the Disposable returned by vscode.languages.register*() — NOT
    //     the provider instance itself (provider classes are not Disposable
    //     unless they explicitly implement dispose()).
    //   • Every registered provider/listener must be in this list so it is
    //     cleaned up when the extension is deactivated.
    context.subscriptions.push(
        formatter,
        rangeFormatter,
        previewFormatting,
        htmlCompletionProvider,
        aspCompletionProvider,
        cssCompletionProvider,
        cssHoverProvider,
        htmlHoverProvider,
        htmlLinkedEditingProvider,
        cssColorProvider,
        jsCompletionProvider,
        emmetCompletionProvider,
        jsHoverProvider,
        jsSignatureHelpProvider,
        combinedSemanticProvider,
        includePathProvider,
        includeDocumentLinkProvider,
        htmlAttributeLinkProvider,
        htmlAttributePathProvider,
        definitionProvider,
        jsDefinitionProvider,
        referenceProvider,
        jsReferenceProvider,
        jsDocumentHighlightProvider,
        renameProvider,
        registerIncludeUpdatesOnRename(),
        jsRenameProvider,
        documentSymbolProvider,
        jsDocumentSymbolProvider,
        workspaceSymbolProvider,
        wsCacheInvalidator,
        aspSignatureHelpProvider,
        aspHoverProvider,
        voidElementQuickFix,
        jsQuickFix,
        inlineStyleTrigger,
        htmlAttrPathTrigger,
    );
}

export function deactivate(): void {
    disposeJsLanguageService();
    disposeAnalysisWorkers();
    disposeIncludeWatchers();
    disposeWorkspaceIndex();
    disposeLog();
}