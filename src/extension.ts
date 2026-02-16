import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { formatCompleteAspFile } from './formatter/htmlFormatter';
import { AspCompletionProvider } from './providers/aspCompletionProvider';
import { addRegionHighlights } from './highlight';

/**
 * Copies the appropriate grammar file based on SQL highlighting setting
 */
function updateGrammarFile(extensionPath: string, enableSQL: boolean): void {
    const syntaxesDir = path.join(extensionPath, 'syntaxes');
    const targetFile = path.join(syntaxesDir, 'asp.tmLanguage.json');

    const sourceFile = enableSQL
        ? path.join(syntaxesDir, 'asp-sql.tmLanguage.json')
        : path.join(syntaxesDir, 'asp-nosql.tmLanguage.json');

    try {
        if (!fs.existsSync(sourceFile)) {
            console.error(`Source grammar file not found: ${sourceFile}`);
            return;
        }

        fs.copyFileSync(sourceFile, targetFile);
        console.log(`✅ Grammar file updated: ${enableSQL ? 'SQL highlighting' : 'No SQL highlighting'}`);
    } catch (error) {
        console.error('Error updating grammar file:', error);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🚀 Classic ASP Language Support ACTIVATED');
    console.log('═══════════════════════════════════════════════════════════════════');

    const extensionPath = context.extensionPath;
    const config = vscode.workspace.getConfiguration('aspLanguageSupport');
    const enableSQL = config.get<boolean>('enableSQLHighlighting', true);

    // Update grammar file for syntax highlighting
    updateGrammarFile(extensionPath, enableSQL);

    // Add ASP region highlighting (colored backgrounds for <% %>)
    try {
        addRegionHighlights(context);
        console.log('✅ ASP region highlighting added');
    } catch (error) {
        console.error('Error adding region highlights:', error);
    }

    // Register formatter for html language, but only activate on .asp files
    const formatter = vscode.languages.registerDocumentFormattingEditProvider('html', {
        async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
            // Only format .asp files, don't interfere with regular .html files
            if (!document.fileName.endsWith('.asp')) {
                return [];
            }
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
    console.log('✅ Formatter registered');

    // Register ASP completion provider for BOTH 'asp' AND 'html' languages
    const aspCompletionProvider = vscode.languages.registerCompletionItemProvider(
        ['asp', 'html'],
        new AspCompletionProvider(),
        '.',  // Trigger on dot
        ' '   // Trigger on space
    );
    console.log('✅ ASP Completion Provider registered for: asp, html');

    // Register command to toggle SQL highlighting
    const toggleCommand = vscode.commands.registerCommand('asp.toggleSQLHighlighting', async () => {
        const config = vscode.workspace.getConfiguration('aspLanguageSupport');
        const currentValue = config.get<boolean>('enableSQLHighlighting', true);

        await config.update('enableSQLHighlighting', !currentValue, vscode.ConfigurationTarget.Global);
        updateGrammarFile(extensionPath, !currentValue);

        const action = await vscode.window.showInformationMessage(
            `SQL highlighting ${!currentValue ? 'enabled' : 'disabled'}. Please reload the window for changes to take effect.`,
            'Reload Window',
            'Later'
        );

        if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });
    console.log('✅ SQL toggle command registered');

    // Watch for SQL highlighting setting changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aspLanguageSupport.enableSQLHighlighting')) {
            const config = vscode.workspace.getConfiguration('aspLanguageSupport');
            const enableSQL = config.get<boolean>('enableSQLHighlighting', true);

            updateGrammarFile(extensionPath, enableSQL);

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

    context.subscriptions.push(
        formatter,
        aspCompletionProvider,
        toggleCommand,
        configWatcher
    );

    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('✅ Extension fully loaded!');
    console.log('═══════════════════════════════════════════════════════════════════');
}

export function deactivate() {
    console.log('Classic ASP Language Support deactivated');
}