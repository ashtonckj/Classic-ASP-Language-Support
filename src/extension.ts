import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { formatCompleteAspFile } from './formatter/htmlFormatter';
import { HtmlCompletionProvider, registerAutoClosingTag, registerEnterKeyHandler } from './providers/htmlCompletionProvider';
import { AspCompletionProvider } from './providers/aspCompletionProvider';
import { CssCompletionProvider } from './providers/cssCompletionProvider';
import { CssHoverProvider } from './providers/cssHoverProvider';
import { registerCssDiagnostics } from './providers/cssDiagnosticsProvider';
import { JsCompletionProvider } from './providers/jsCompletionProvider';
import { addRegionHighlights } from './highlight';

/**
 * Copies the appropriate grammar file based on SQL highlighting setting
 */
function updateGrammarFile(extensionPath: string, enableSQL: boolean): void {
    const syntaxesDir = path.join(extensionPath, 'syntaxes');
    const targetFile = path.join(syntaxesDir, 'asp.tmLanguage.json');

    // Choose source file based on setting
    const sourceFile = enableSQL
        ? path.join(syntaxesDir, 'asp-sql.tmLanguage.json')
        : path.join(syntaxesDir, 'asp-nosql.tmLanguage.json');

    try {
        // Check if source file exists
        if (!fs.existsSync(sourceFile)) {
            console.error(`Source grammar file not found: ${sourceFile}`);
            return;
        }

        // Copy the appropriate grammar file to the active location
        fs.copyFileSync(sourceFile, targetFile);
        console.log(`Grammar file updated: ${enableSQL ? 'SQL highlighting enabled' : 'SQL highlighting disabled'}`);
    } catch (error) {
        console.error('Error updating grammar file:', error);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Classic ASP Language Support is now active!');

    // Get the extension path
    const extensionPath = context.extensionPath;

    // Get initial SQL highlighting setting
    const config = vscode.workspace.getConfiguration('aspLanguageSupport');
    const enableSQL = config.get<boolean>('enableSQLHighlighting', true);

    // Update grammar file on activation
    updateGrammarFile(extensionPath, enableSQL);

    // Add ASP region highlighting
    addRegionHighlights(context);

    // Register CSS diagnostics (validate as you type)
    registerCssDiagnostics(context);

    // Register formatter
    const formatter = vscode.languages.registerDocumentFormattingEditProvider('asp', {
        async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
            const edits: vscode.TextEdit[] = [];
            const fullText = document.getText();
            const formattedText = await formatCompleteAspFile(fullText);

            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(fullText.length)
            );

            edits.push(vscode.TextEdit.replace(fullRange, formattedText));
            return edits;
        }
    });

    // Register completion providers
    const htmlCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new HtmlCompletionProvider(),
        '<', ' ', '='  // Trigger characters
    );

    const aspCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new AspCompletionProvider(),
        '.'  // Trigger for object methods (e.g., Response.)
    );

    const cssCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new CssCompletionProvider(),
        ':', ';', ' '  // Trigger characters
    );

    const cssHoverProvider = vscode.languages.registerHoverProvider(
        'asp',
        new CssHoverProvider()
    );

    const jsCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'asp',
        new JsCompletionProvider(),
        '.'  // Trigger for object methods (e.g., element.)
    );

    // Register auto-closing tags
    registerAutoClosingTag(context);

    // Register Enter key handler for smart tag closing
    registerEnterKeyHandler(context);

    // Register command to toggle SQL highlighting
    const toggleCommand = vscode.commands.registerCommand('asp.toggleSQLHighlighting', async () => {
        const config = vscode.workspace.getConfiguration('aspLanguageSupport');
        const currentValue = config.get<boolean>('enableSQLHighlighting', true);

        // Toggle the setting
        await config.update('enableSQLHighlighting', !currentValue, vscode.ConfigurationTarget.Global);

        // Update grammar file
        updateGrammarFile(extensionPath, !currentValue);

        // Prompt user to reload window for grammar change to take effect
        const action = await vscode.window.showInformationMessage(
            `SQL highlighting ${!currentValue ? 'enabled' : 'disabled'}. Please reload the window for changes to take effect.`,
            'Reload Window',
            'Later'
        );

        if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });

    // Watch for SQL highlighting setting changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aspLanguageSupport.enableSQLHighlighting')) {
            const config = vscode.workspace.getConfiguration('aspLanguageSupport');
            const enableSQL = config.get<boolean>('enableSQLHighlighting', true);

            // Update grammar file
            updateGrammarFile(extensionPath, enableSQL);

            // Prompt user to reload window for grammar change to take effect
            vscode.window.showInformationMessage(
                `SQL highlighting setting changed to ${enableSQL ? 'enabled' : 'disabled'}. Please reload the window for changes to take effect.`,
                'Reload Window',
                'Later'
            ).then(selection => {
                if (selection === 'Reload Window') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        }
    });

    // Add all to subscriptions
    context.subscriptions.push(
        formatter,
        htmlCompletionProvider,
        aspCompletionProvider,
        cssCompletionProvider,
        cssHoverProvider,
        jsCompletionProvider,
        toggleCommand,
        configWatcher
    );
}

export function deactivate() {}