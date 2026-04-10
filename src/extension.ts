import * as vscode from 'vscode';
import { formatCompleteAspFile } from './formatter/htmlFormatter';
import { HtmlCompletionProvider } from './providers/htmlCompletionProvider';
import { registerAutoClosingTag, registerEnterKeyHandler, registerTabKeyHandler, registerSmartQuoteHandler, registerLineContinuationGuard } from './providers/aspIndentProvider';
import { AspCompletionProvider } from './providers/aspCompletionProvider';
import { CssCompletionProvider } from './providers/cssCompletionProvider';
import { CssHoverProvider } from './providers/cssHoverProvider';
import { registerCssDiagnostics } from './providers/cssDiagnosticsProvider';
import { registerHtmlStructureDiagnostics, VoidElementQuickFixProvider } from './providers/htmlStructureDiagnosticsProvider';
import { registerAspStructureDiagnostics } from './providers/aspStructureDiagnosticsProvider';
import { JsCompletionProvider } from './providers/jsCompletionProvider';
import { JsHoverProvider } from './providers/jsHoverProvider';
import { JsSignatureHelpProvider } from './providers/jsSignatureHelpProvider';
// Import the JS semantic provider alongside the COMBINED legend.
// aspSemanticProvider.ts must also import COMBINED_SEMANTIC_LEGEND from here
// (or from jsSemanticProvider.ts directly) instead of declaring its own legend,
// so both providers use identical type-index mappings.
import { JsSemanticTokensProvider, COMBINED_SEMANTIC_LEGEND } from './providers/jsSemanticProvider';
import { registerJsDiagnostics } from './providers/jsDiagnosticsProvider';
import { disposeJsLanguageService, initializeJsLanguageService } from './utils/jsUtils';
import { IncludePathCompletionProvider, AspDefinitionProvider } from './providers/includeProvider';
import { IncludeDocumentLinkProvider, HtmlAttributeLinkProvider, HtmlAttributePathCompletionProvider } from './providers/linkProvider';
// ASP semantic provider must now use COMBINED_SEMANTIC_LEGEND — see note above.
import { AspSemanticTokensProvider } from './providers/aspSemanticProvider';
import { AspHoverProvider } from './providers/aspHoverProvider';
import { AspRenameProvider } from './providers/aspRenameProvider';
import { addRegionHighlights } from './highlight';
import { AspDocumentSymbolProvider } from './providers/aspDocumentSymbolProvider';
import { JsDocumentSymbolProvider } from './providers/jsDocumentSymbolProvider';
import { AspWorkspaceSymbolProvider, clearWorkspaceSymbolCache } from './providers/aspWorkspaceSymbolProvider';
import { AspSignatureHelpProvider } from './providers/aspSignatureHelpProvider';

// Returns line-level TextEdits instead of replacing the whole document.
// Only changed line ranges are touched — Ctrl+Z still undoes everything in one step.
function computeLineEdits(document: vscode.TextDocument, original: string, formatted: string): vscode.TextEdit[] {
    const originalLines  = original.split('\n');
    const formattedLines = formatted.split('\n');
    const edits: vscode.TextEdit[] = [];

    let i = 0;
    while (i < Math.max(originalLines.length, formattedLines.length)) {
        if (originalLines[i] === formattedLines[i]) { i++; continue; }

        let j = i + 1;
        while (
            j < Math.max(originalLines.length, formattedLines.length) &&
            originalLines[j] !== formattedLines[j]
        ) { j++; }

        const endLine  = Math.min(j, originalLines.length);
        const newText  = formattedLines.slice(i, j).join('\n');
        const startPos = new vscode.Position(i, 0);
        const endPos   = endLine < originalLines.length
            ? new vscode.Position(endLine, 0)
            : document.positionAt(original.length);

        edits.push(vscode.TextEdit.replace(
            new vscode.Range(startPos, endPos),
            newText + (endLine < originalLines.length ? '\n' : '')
        ));
        i = j;
    }

    return edits;
}

// Shared structure issue check used by both the formatter and the preview.
function getStructureIssueCount(
    document: vscode.TextDocument,
    htmlCollection: vscode.DiagnosticCollection,
    aspCollection:  vscode.DiagnosticCollection
): number {
    return (htmlCollection.get(document.uri) ?? []).length +
           (aspCollection.get(document.uri)  ?? []).length;
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

export function activate(context: vscode.ExtensionContext) {
    console.log('Classic ASP Language Support is now active!');

    // Initialize JS language service with extension path for custom type definitions
    initializeJsLanguageService(context.extensionPath);

    addRegionHighlights(context);
    registerCssDiagnostics(context);
    registerJsDiagnostics(context);
    const htmlStructureCollection = registerHtmlStructureDiagnostics(context);
    const aspStructureCollection  = registerAspStructureDiagnostics(context);

    // ── Formatter ─────────────────────────────────────────────────────────────
    const formatter = vscode.languages.registerDocumentFormattingEditProvider('asp', {
        async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
            const total = getStructureIssueCount(document, htmlStructureCollection, aspStructureCollection);
            if (total > 0) {
                vscode.window.showWarningMessage(
                    `Formatting skipped — ${total} structure issue${total === 1 ? '' : 's'} found. ` +
                    `Fix the highlighted warnings first.`
                );
                return [];
            }

            const fullText  = document.getText();
            const formatted = await formatCompleteAspFile(fullText);

            const config = vscode.workspace.getConfiguration('aspLanguageSupport');
            if (config.get<boolean>('formatPreview', false)) {
                if (formatted === fullText) {
                    vscode.window.showInformationMessage('No formatting changes — file is already formatted.');
                    return [];
                }
                await openFormattingPreview(context, document, formatted);
                return [];
            }

            return computeLineEdits(document, fullText, formatted);
        }
    });

    // ── Completion providers ──────────────────────────────────────────────────
    const htmlCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', new HtmlCompletionProvider(), '<', '/', ' ', '='
    );

    const aspCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', new AspCompletionProvider(), '.', ' '
    );

    const cssCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', new CssCompletionProvider(),
        ':', ';', ' ', '"', "'", '-',
        'a','b','c','d','e','f','g','h','i','j','k','l','m',
        'n','o','p','q','r','s','t','u','v','w','x','y','z'
    );

    // JS completions — '.' triggers member access completions; '(' triggers
    // completions after a function name is typed.  Letter/digit triggers are
    // intentionally omitted — VS Code's built-in word-based filter handles
    // filtering the returned list as the user continues typing, and
    // isIncomplete:false tells it the list is already complete.
    const jsCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', new JsCompletionProvider(),
        '.', '('
    );

    const includePathProvider = vscode.languages.registerCompletionItemProvider(
        'asp', new IncludePathCompletionProvider(),
        '"', "'", '/', '\\', '.',
        'a','b','c','d','e','f','g','h','i','j','k','l','m',
        'n','o','p','q','r','s','t','u','v','w','x','y','z',
        'A','B','C','D','E','F','G','H','I','J','K','L','M',
        'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
        '0','1','2','3','4','5','6','7','8','9','_','-'
    );

    // ── Document link providers ───────────────────────────────────────────────
    const includeDocumentLinkProvider = vscode.languages.registerDocumentLinkProvider(
        'asp', new IncludeDocumentLinkProvider()
    );

    const htmlAttributeLinkProvider = vscode.languages.registerDocumentLinkProvider(
        'asp', new HtmlAttributeLinkProvider()
    );

    const htmlAttributePathProvider = vscode.languages.registerCompletionItemProvider(
        'asp', new HtmlAttributePathCompletionProvider(),
        '"', "'", '/', '\\', '.',
        'a','b','c','d','e','f','g','h','i','j','k','l','m',
        'n','o','p','q','r','s','t','u','v','w','x','y','z',
        'A','B','C','D','E','F','G','H','I','J','K','L','M',
        'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
        '0','1','2','3','4','5','6','7','8','9','_','-'
    );

    // ── Go To Definition ──────────────────────────────────────────────────────
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        'asp', new AspDefinitionProvider()
    );

    // ── Rename ────────────────────────────────────────────────────────────────
    const renameProvider = vscode.languages.registerRenameProvider(
        'asp', new AspRenameProvider()
    );

    // ── Document symbols ─────────────────────────────────────────────────────
    const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
        'asp', new AspDocumentSymbolProvider()
    );

    const jsDocumentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
        'asp', new JsDocumentSymbolProvider()
    );

    // ── Signature help ───────────────────────────────────────────────────────
    const aspSignatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
        'asp',
        new AspSignatureHelpProvider(),
        { triggerCharacters: ['('], retriggerCharacters: [','] }
    );

    const jsSignatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
        'asp',
        new JsSignatureHelpProvider(),
        { triggerCharacters: ['('], retriggerCharacters: [','] }
    );

    // ── Workspace symbol search (Ctrl+T) ─────────────────────────────────────
    const workspaceSymbolProvider = vscode.languages.registerWorkspaceSymbolProvider(
        new AspWorkspaceSymbolProvider()
    );

    const wsCacheInvalidator = vscode.workspace.onDidSaveTextDocument(doc => {
        if (/\.(asp|inc)$/i.test(doc.uri.fsPath)) {
            clearWorkspaceSymbolCache(doc.uri.fsPath);
        }
    });

    // ── Semantic tokens ───────────────────────────────────────────────────────
    // IMPORTANT: VS Code only honours ONE DocumentSemanticTokensProvider per
    // language. Registering two (ASP + JS) meant whichever ran second silently
    // discarded the other's tokens. The fix is a single combined provider that
    // runs both sub-providers and merges their delta-encoded token streams.
    // Both sub-providers already share COMBINED_SEMANTIC_LEGEND so all indices
    // and colours are always consistent.
    const aspSemanticProviderInstance = new AspSemanticTokensProvider();
    const jsSemanticProviderInstance  = new JsSemanticTokensProvider();

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
        {
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
        },
        COMBINED_SEMANTIC_LEGEND
    );

    // ── Void element quick fix ─────────────────────────────────────────────────
    const voidElementQuickFix = vscode.languages.registerCodeActionsProvider(
        'asp', new VoidElementQuickFixProvider(),
        { providedCodeActionKinds: VoidElementQuickFixProvider.providedCodeActionKinds }
    );

    // ── Hover providers ───────────────────────────────────────────────────────
    const aspHoverProvider = vscode.languages.registerHoverProvider(
        'asp', new AspHoverProvider()
    );

    const cssHoverProvider = vscode.languages.registerHoverProvider(
        'asp', new CssHoverProvider()
    );

    const jsHoverProvider = vscode.languages.registerHoverProvider(
        'asp', new JsHoverProvider()
    );

    // ── Key handlers ──────────────────────────────────────────────────────────
    registerAutoClosingTag(context);
    registerEnterKeyHandler(context);
    registerTabKeyHandler(context);
    registerSmartQuoteHandler(context);
    registerLineContinuationGuard(context);

    // ── Auto-trigger CSS suggestions inside empty style="" ────────────────────
    const inlineStyleTrigger = vscode.window.onDidChangeTextEditorSelection(e => {
        const editor = e.textEditor;
        const doc    = editor.document;
        if (doc.languageId !== 'asp') return;
        if (e.selections.length !== 1 || !e.selections[0].isEmpty) return;

        const offset      = doc.offsetAt(e.selections[0].active);
        const content     = doc.getText();
        const searchStart = Math.max(0, offset - 200);
        const match       = content.slice(searchStart, offset).match(/style\s*=\s*(["'])([\s\S]*)$/i);
        if (!match) return;

        const valueStart = searchStart + match.index! + match[0].length - match[2].length;
        if (content[offset] === match[1] && offset === valueStart) {
            setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 50);
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

        setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 50);
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
        htmlCompletionProvider,
        aspCompletionProvider,
        cssCompletionProvider,
        cssHoverProvider,
        jsCompletionProvider,
        jsHoverProvider,
        jsSignatureHelpProvider,
        combinedSemanticProvider,
        includePathProvider,
        includeDocumentLinkProvider,
        htmlAttributeLinkProvider,
        htmlAttributePathProvider,
        definitionProvider,
        renameProvider,
        documentSymbolProvider,
        jsDocumentSymbolProvider,
        workspaceSymbolProvider,
        wsCacheInvalidator,
        aspSignatureHelpProvider,
        aspHoverProvider,
        voidElementQuickFix,
        inlineStyleTrigger,
        htmlAttrPathTrigger,
    );
}

export function deactivate(): void {
    disposeJsLanguageService();
}