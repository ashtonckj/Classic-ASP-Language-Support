import * as vscode from 'vscode';
import { formatCompleteAspFile } from './formatter/htmlFormatter';
import { HtmlCompletionProvider, registerAutoClosingTag, registerEnterKeyHandler, registerTabKeyHandler } from './providers/htmlCompletionProvider';
import { AspCompletionProvider } from './providers/aspCompletionProvider';
import { CssCompletionProvider } from './providers/cssCompletionProvider';
import { CssHoverProvider } from './providers/cssHoverProvider';
import { registerCssDiagnostics } from './providers/cssDiagnosticsProvider';
import { JsCompletionProvider } from './providers/jsCompletionProvider';
import { IncludePathCompletionProvider, AspDefinitionProvider } from './providers/includeProvider';
import { AspSemanticTokensProvider, ASP_SEMANTIC_LEGEND } from './providers/aspSemanticProvider';
import { AspHoverProvider } from './providers/aspHoverProvider';
import { addRegionHighlights } from './highlight';

export function activate(context: vscode.ExtensionContext) {
    console.log('Classic ASP Language Support is now active!');

    // Add ASP region highlighting
    addRegionHighlights(context);

    // Register CSS diagnostics (validate as you type)
    registerCssDiagnostics(context);

    // Register formatter
    const formatter = vscode.languages.registerDocumentFormattingEditProvider('asp', {
        async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
            const edits      = [];
            const fullText   = document.getText();
            const formatted  = await formatCompleteAspFile(fullText);
            const fullRange  = new vscode.Range(document.positionAt(0), document.positionAt(fullText.length));
            edits.push(vscode.TextEdit.replace(fullRange, formatted));
            return edits;
        }
    });

    // ── Completion providers ──────────────────────────────────────────────────

    const htmlCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new HtmlCompletionProvider(),
        '<', ' ', '='
    );

    const aspCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new AspCompletionProvider(),
        '.', ' '  // '.' for member access (rs./Response.), ' ' to re-trigger after Call keyword
    );

    const cssCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new CssCompletionProvider(),
        ':', ';', ' ', '"', "'", '-',
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'
    );

    const cssHoverProvider = vscode.languages.registerHoverProvider(
        'asp',
        new CssHoverProvider()
    );

    const jsCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new JsCompletionProvider(),
        '.'
    );

    // Include file path suggestions — triggers inside the quotes of #include directives
    const includePathProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new IncludePathCompletionProvider(),
        '"', "'", '/', '\\'  // Trigger on quote open and path separators
    );

    // ── Go To Definition ──────────────────────────────────────────────────────
    // Handles F12 / Ctrl+Click on any Function, Sub, variable, or constant.
    // Works across the current file AND all #include'd files.
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        'asp',
        new AspDefinitionProvider()
    );

    // ── Semantic tokens — smart highlighting of user-defined functions/subs ───
    // Only highlights names that are actually defined in this file or an include.
    // Uses VS Code's semantic token API so it works with all themes automatically.
    const semanticTokensProviderInstance = new AspSemanticTokensProvider();
    const semanticProvider = vscode.languages.registerDocumentSemanticTokensProvider(
        'asp',
        semanticTokensProviderInstance,
        ASP_SEMANTIC_LEGEND
    );

    // ── Hover docs ────────────────────────────────────────────────────────────
    // Shows documentation when hovering over functions, subs, variables,
    // constants, COM object variables, COM members, and VBScript keywords.
    const aspHoverProvider = vscode.languages.registerHoverProvider(
        'asp',
        new AspHoverProvider()
    );

    // ── Register key handlers ─────────────────────────────────────────────────
    registerAutoClosingTag(context);
    registerEnterKeyHandler(context);
    registerTabKeyHandler(context);

    // ── Auto-trigger CSS suggestions inside empty style="" ────────────────────
    // Fires when a completion places the cursor between empty style quotes.
    const inlineStyleTrigger = vscode.window.onDidChangeTextEditorSelection(e => {
        const editor = e.textEditor;
        const doc    = editor.document;
        if (doc.languageId !== 'asp') return;
        if (e.selections.length !== 1) return;

        const selection = e.selections[0];
        if (!selection.isEmpty) return;

        const offset      = doc.offsetAt(selection.active);
        const content     = doc.getText();
        const searchStart = Math.max(0, offset - 200);
        const searchArea  = content.slice(searchStart, offset);
        const match       = searchArea.match(/style\s*=\s*(["'])([\s\S]*)$/i);
        if (!match) return;

        const openingQuote = match[1];
        const valueStart   = searchStart + match.index! + match[0].length - match[2].length;
        const charAtCursor = content[offset];

        if (charAtCursor === openingQuote && offset === valueStart) {
            setTimeout(() => {
                vscode.commands.executeCommand('editor.action.triggerSuggest');
            }, 50);
        }
    });

    // ── Register all subscriptions ────────────────────────────────────────────
    context.subscriptions.push(
        formatter,
        htmlCompletionProvider,
        aspCompletionProvider,
        cssCompletionProvider,
        cssHoverProvider,
        jsCompletionProvider,
        includePathProvider,
        definitionProvider,
        semanticProvider,
        semanticTokensProviderInstance,
        aspHoverProvider,
        inlineStyleTrigger
    );
}

export function deactivate() {}