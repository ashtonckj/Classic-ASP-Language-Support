import * as vscode from 'vscode';
import { formatCompleteAspFile } from './formatter/htmlFormatter';
import { HtmlCompletionProvider } from './providers/htmlCompletionProvider';
import { registerAutoClosingTag, registerEnterKeyHandler, registerTabKeyHandler } from './providers/aspIndentProvider';
import { AspCompletionProvider } from './providers/aspCompletionProvider';
import { CssCompletionProvider } from './providers/cssCompletionProvider';
import { CssHoverProvider } from './providers/cssHoverProvider';
import { registerCssDiagnostics } from './providers/cssDiagnosticsProvider';
import { registerHtmlStructureDiagnostics, VoidElementQuickFixProvider } from './providers/htmlStructureDiagnosticsProvider';
import { registerAspStructureDiagnostics } from './providers/aspStructureDiagnosticsProvider';
import { JsCompletionProvider } from './providers/jsCompletionProvider';
import { IncludePathCompletionProvider, AspDefinitionProvider } from './providers/includeProvider';
import { IncludeDocumentLinkProvider, HtmlAttributeLinkProvider, HtmlAttributePathCompletionProvider } from './providers/linkProvider';
import { AspSemanticTokensProvider, ASP_SEMANTIC_LEGEND } from './providers/aspSemanticProvider';
import { AspHoverProvider } from './providers/aspHoverProvider';
import { addRegionHighlights } from './highlight';

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

    // Clean up the virtual provider once the diff tab is closed
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

    // Disable word-based suggestions for ASP — all real completions come from
    // our own providers, and the built-in word scanner picks up SQL identifiers
    // inside string literals which creates noise.
    const aspConfig = vscode.workspace.getConfiguration('editor', { languageId: 'asp' });
    aspConfig.update('wordBasedSuggestions', 'off', vscode.ConfigurationTarget.Global);

    addRegionHighlights(context);
    registerCssDiagnostics(context);
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

            // When formatPreview is enabled, open a diff editor instead of
            // applying changes. The formatter returns no edits so the file
            // is never touched until the user formats again with preview off.
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

    const jsCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', new JsCompletionProvider(), '.'
    );

    // Triggers on letters + path chars so suggestions stay live as the user types
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
    // F12 / Ctrl+Click on functions, subs, variables, constants, and COM vars.
    // Also guards against HTML attribute values falling through to symbol lookup.
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        'asp', new AspDefinitionProvider()
    );

    // ── Semantic tokens ───────────────────────────────────────────────────────
    // Highlights user-defined function/sub names using VS Code's semantic token API.
    const semanticTokensProviderInstance = new AspSemanticTokensProvider();
    const semanticProvider = vscode.languages.registerDocumentSemanticTokensProvider(
        'asp', semanticTokensProviderInstance, ASP_SEMANTIC_LEGEND
    );

    // ── Void element quick fix ─────────────────────────────────────────────────
    const voidElementQuickFix = vscode.languages.registerCodeActionsProvider(
        'asp', new VoidElementQuickFixProvider(),
        { providedCodeActionKinds: VoidElementQuickFixProvider.providedCodeActionKinds }
    );

    // ── Hover docs ────────────────────────────────────────────────────────────
    // Shows docs for functions, subs, variables, COM members, and VBScript keywords.
    const aspHoverProvider = vscode.languages.registerHoverProvider(
        'asp', new AspHoverProvider()
    );

    // ── CSS hover ─────────────────────────────────────────────────────────────
    const cssHoverProvider = vscode.languages.registerHoverProvider(
        'asp', new CssHoverProvider()
    );

    // ── Key handlers ──────────────────────────────────────────────────────────
    registerAutoClosingTag(context);
    registerEnterKeyHandler(context);
    registerTabKeyHandler(context);

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

    // ── Auto-trigger path suggestions inside href/src/action/data-src values ──
    // VS Code's built-in HTML provider closes the suggestion session with
    // isIncomplete:false, preventing our provider from firing on plain letter
    // keystrokes. Force-retriggering on every document change inside a recognised
    // attribute value bypasses this entirely.
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
    context.subscriptions.push(
        formatter,
        htmlCompletionProvider,
        aspCompletionProvider,
        cssCompletionProvider,
        cssHoverProvider,
        jsCompletionProvider,
        includePathProvider,
        includeDocumentLinkProvider,
        htmlAttributeLinkProvider,
        htmlAttributePathProvider,
        definitionProvider,
        semanticProvider,
        semanticTokensProviderInstance,
        aspHoverProvider,
        voidElementQuickFix,
        inlineStyleTrigger,
        htmlAttrPathTrigger,
    );
}

export function deactivate() {}