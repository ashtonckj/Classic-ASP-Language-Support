import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
import { AspSqlDecorator } from './providers/aspSqlDecorator';
import { addRegionHighlights } from './highlight';

/**
 * Copies the appropriate grammar file based on SQL highlighting setting
 */
function updateGrammarFile(extensionPath: string, enableSQL: boolean): void {
    const syntaxesDir = path.join(extensionPath, 'syntaxes');
    const targetFile  = path.join(syntaxesDir, 'asp.tmLanguage.json');

    // Choose source file based on setting
    const sourceFile = enableSQL
        ? path.join(syntaxesDir, 'asp-sql.tmLanguage.json')
        : path.join(syntaxesDir, 'asp-nosql.tmLanguage.json');

    try {
        if (!fs.existsSync(sourceFile)) {
            console.error(`Source grammar file not found: ${sourceFile}`);
            return;
        }
        fs.copyFileSync(sourceFile, targetFile);
        console.log(`Grammar file updated: ${enableSQL ? 'SQL highlighting enabled' : 'SQL highlighting disabled'}`);
    } catch (error) {
        console.error('Error updating grammar file:', error);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Classic ASP Language Support is now active!');

    const extensionPath = context.extensionPath;

    // Get initial SQL highlighting setting
    const config    = vscode.workspace.getConfiguration('aspLanguageSupport');
    const enableSQL = config.get<boolean>('enableSQLHighlighting', true);

    // Update grammar file on activation
    try {
        updateGrammarFile(extensionPath, enableSQL);
    } catch (error) {
        console.error('ASP: Failed to update grammar file on activation:', error);
    }

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
    const semanticProvider = vscode.languages.registerDocumentSemanticTokensProvider(
        'asp',
        new AspSemanticTokensProvider(),
        ASP_SEMANTIC_LEGEND
    );

    // ── Hover docs ────────────────────────────────────────────────────────────
    // Shows documentation when hovering over functions, subs, variables,
    // constants, COM object variables, COM members, and VBScript keywords.
    const aspHoverProvider = vscode.languages.registerHoverProvider(
        'asp',
        new AspHoverProvider()
    );

    // ── SQL string decorator ──────────────────────────────────────────────────
    // Stitches & _ continuation lines, detects confirmed SQL strings
    // (requires DML verb + clause keyword), and applies background decoration
    // to distinguish SQL strings from regular strings across all lines.
    const sqlDecorator = new AspSqlDecorator();

    // ── Register key handlers ─────────────────────────────────────────────────
    registerAutoClosingTag(context);
    registerEnterKeyHandler(context);
    registerTabKeyHandler(context);

    // ── Toggle SQL highlighting command ───────────────────────────────────────
    const toggleCommand = vscode.commands.registerCommand('asp.toggleSQLHighlighting', async () => {
        const config       = vscode.workspace.getConfiguration('aspLanguageSupport');
        const currentValue = config.get<boolean>('enableSQLHighlighting', true);

        await config.update('enableSQLHighlighting', !currentValue, vscode.ConfigurationTarget.Global);
        updateGrammarFile(extensionPath, !currentValue);

        const action = await vscode.window.showInformationMessage(
            `SQL highlighting ${!currentValue ? 'enabled' : 'disabled'}. Please reload the window for changes to take effect.`,
            'Reload Window', 'Later'
        );
        if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });

    // ── Watch for SQL highlighting setting changes ────────────────────────────
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aspLanguageSupport.enableSQLHighlighting')) {
            const config    = vscode.workspace.getConfiguration('aspLanguageSupport');
            const enableSQL = config.get<boolean>('enableSQLHighlighting', true);
            updateGrammarFile(extensionPath, enableSQL);

            vscode.window.showInformationMessage(
                `SQL highlighting setting changed to ${enableSQL ? 'enabled' : 'disabled'}. Please reload the window for changes to take effect.`,
                'Reload Window', 'Later'
            ).then(selection => {
                if (selection === 'Reload Window') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        }
    });

    // ── Auto-trigger CSS suggestions inside empty style="" ────────────────────
    // Fires when a completion places the cursor between empty style quotes.
    const inlineStyleTrigger = vscode.window.onDidChangeTextEditorSelection(e => {
        const editor = e.textEditor;
        const doc    = editor.document;
        if (doc.languageId !== 'asp') return;
        if (e.selections.length !== 1) return;

        const selection = e.selections[0];
        if (!selection.isEmpty) return;

        const offset     = doc.offsetAt(selection.active);
        const content    = doc.getText();
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
        aspHoverProvider,
        sqlDecorator,
        toggleCommand,
        configWatcher,
        inlineStyleTrigger
    );
}

export function deactivate() {}