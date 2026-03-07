import * as vscode from 'vscode';
import { formatCompleteAspFile } from './formatter/htmlFormatter';
import { HtmlCompletionProvider, registerAutoClosingTag, registerEnterKeyHandler, registerTabKeyHandler } from './providers/htmlCompletionProvider';
import { AspCompletionProvider } from './providers/aspCompletionProvider';
import { CssCompletionProvider } from './providers/cssCompletionProvider';
import { CssHoverProvider } from './providers/cssHoverProvider';
import { registerCssDiagnostics } from './providers/cssDiagnosticsProvider';
import { JsCompletionProvider } from './providers/jsCompletionProvider';
import { IncludePathCompletionProvider, AspDefinitionProvider } from './providers/includeProvider';
import { IncludeDocumentLinkProvider, HtmlAttributeLinkProvider } from './providers/linkProvider';
import { AspSemanticTokensProvider, ASP_SEMANTIC_LEGEND } from './providers/aspSemanticProvider';
import { AspHoverProvider } from './providers/aspHoverProvider';
import { addRegionHighlights } from './highlight';

export function activate(context: vscode.ExtensionContext) {
    console.log('Classic ASP Language Support is now active!');

    // Disable word-based suggestions for ASP — all real completions come from
    // our own providers, and the built-in word scanner picks up SQL identifiers
    // inside string literals which creates noise.
    const aspConfig = vscode.workspace.getConfiguration('editor', { languageId: 'asp' });
    aspConfig.update('wordBasedSuggestions', 'off', vscode.ConfigurationTarget.Global);

    addRegionHighlights(context);
    registerCssDiagnostics(context);

    // ── Formatter ─────────────────────────────────────────────────────────────
    const formatter = vscode.languages.registerDocumentFormattingEditProvider('asp', {
        async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
            const fullText  = document.getText();
            const formatted = await formatCompleteAspFile(fullText);
            const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(fullText.length));
            return [vscode.TextEdit.replace(fullRange, formatted)];
        }
    });

    // ── Completion providers ──────────────────────────────────────────────────
    const htmlCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp', new HtmlCompletionProvider(), '<', ' ', '='
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
    // Both providers give persistent underlines + "Follow link (Ctrl+Click)" tooltip.
    const includeDocumentLinkProvider = vscode.languages.registerDocumentLinkProvider(
        'asp', new IncludeDocumentLinkProvider()
    );

    const htmlAttributeLinkProvider = vscode.languages.registerDocumentLinkProvider(
        'asp', new HtmlAttributeLinkProvider()
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
        definitionProvider,
        semanticProvider,
        semanticTokensProviderInstance,
        aspHoverProvider,
        inlineStyleTrigger,
    );
}

export function deactivate() {}