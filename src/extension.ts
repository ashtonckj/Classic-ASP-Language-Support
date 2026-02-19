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

/**
 * Ensures *.asp files are associated with HTML so VSCode provides
 * full HTML, CSS and JavaScript IntelliSense.
 * Returns true if the association was newly added (reload required).
 */
function ensureAspFileAssociation(): boolean {
    const filesConfig = vscode.workspace.getConfiguration('files');
    const associations: Record<string, string> = filesConfig.get('associations') ?? {};

    if (associations['*.asp'] === 'html') {
        return false; // already set, no reload needed
    }

    filesConfig.update(
        'associations',
        { ...associations, '*.asp': 'html' },
        vscode.ConfigurationTarget.Global
    );

    return true; // newly added, reload required
}

export function activate(context: vscode.ExtensionContext) {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🚀 Classic ASP Language Support ACTIVATED');
    console.log('═══════════════════════════════════════════════════════════════════');

    const extensionPath = context.extensionPath;
    const config = vscode.workspace.getConfiguration('aspLanguageSupport');
    const enableSQL = config.get<boolean>('enableSqlInStrings', true);
    const disableHtmlValidation = config.get<boolean>('disableHtml', true);

    // Update grammar file for syntax highlighting
    updateGrammarFile(extensionPath, enableSQL);

    // Ensure *.asp files are treated as HTML for full IntelliSense
    const associationAdded = ensureAspFileAssociation();
    console.log(`✅ ASP file association: ${associationAdded ? 'newly set (reload needed)' : 'already active'}`);

    // Apply HTML validation setting
    if (disableHtmlValidation) {
        const htmlConfig = vscode.workspace.getConfiguration('html');
        htmlConfig.update('validate.scripts', false, vscode.ConfigurationTarget.Global).then(() => {
            console.log('✅ HTML script validation disabled (ASP-friendly mode)');
        });
    }

    // Prompt user to reload if the file association was just added
    if (associationAdded) {
        vscode.window.showInformationMessage(
            'ASP Language Support: Reload VS Code to activate full HTML, CSS & JS IntelliSense for .asp files.',
            'Reload Now',
            'Later'
        ).then(choice => {
            if (choice === 'Reload Now') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    } else {
        vscode.window.showInformationMessage(
            'Classic ASP Language Support active — full HTML, CSS & JS IntelliSense enabled.'
        );
    }

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

    // Apply VBScript indent/dedent rules to the 'html' language so they work in .asp files.
    // language-configuration.json is only read for the 'asp' language ID, but since .asp files
    // are associated as 'html', we must set these rules programmatically at runtime.
    vscode.languages.setLanguageConfiguration('html', {
        indentationRules: {
            increaseIndentPattern: /^\s*(?:If\b.*\bThen|ElseIf\b.*\bThen|Else|For\b.*\bTo\b.*|For\s+Each\b.*\bIn\b.*|Do|Do\s+(?:While|Until)\b.*|While\b.*|Select\s+Case\b.*|Case\b.*|Sub\s+\w.*|Function\s+\w.*|Class\s+\w.*|With\s+\w.*|Property\s+(?:Get|Let|Set)\b.*)\s*$/i,
            decreaseIndentPattern: /^\s*(?:End\s+(?:If|Sub|Function|Select|With|Class|Property)|Next|Loop|Wend|ElseIf\b|Else|Case\b)\s*$/i
        },
        onEnterRules: [
            {
                beforeText: /^\s*(?:If\s+.+\s+Then|ElseIf\s+.+\s+Then|Else|For\s.+To.+|For\s+Each\s.+In.+|Do|Do\s+(?:While|Until).+|While\s+.+|Select\s+Case\s+.+|Sub\s+\w[^']*|Function\s+\w[^']*|Class\s+\w[^']*|With\s+\S+|Property\s+(?:Get|Let|Set)\s+\w[^']*)\s*$/i,
                action: { indentAction: vscode.IndentAction.Indent }
            },
            {
                beforeText: /^\s*(?:End\s+(?:If|Sub|Function|Select|With|Class|Property)|Next|Loop|Wend)\s*$/i,
                action: { indentAction: vscode.IndentAction.None }
            },
            {
                beforeText: /^\s*(?:Else|ElseIf\s+.+\s+Then)\s*$/i,
                action: { indentAction: vscode.IndentAction.IndentOutdent }
            },
            {
                beforeText: /^\s*(?:Case\s+(?!Else).+|Case\s+Else)\s*$/i,
                action: { indentAction: vscode.IndentAction.IndentOutdent }
            }
        ]
    });
    console.log('✅ VBScript indent rules applied to html language');

    // Register ASP completion provider for BOTH 'asp' AND 'html' languages
    const aspCompletionProvider = vscode.languages.registerCompletionItemProvider(
        ['asp', 'html'],
        new AspCompletionProvider(),
        '.'   // Trigger on dot only (space removed — caused completions to fire inside strings)
    );
    console.log('✅ ASP Completion Provider registered for: asp, html');

    // Register command to toggle SQL highlighting
    const toggleCommand = vscode.commands.registerCommand('asp.toggleSQLHighlighting', async () => {
        const config = vscode.workspace.getConfiguration('aspLanguageSupport');
        const currentValue = config.get<boolean>('enableSqlInStrings', true);

        await config.update('enableSqlInStrings', !currentValue, vscode.ConfigurationTarget.Global);
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

    // Watch for setting changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aspLanguageSupport.enableSqlInStrings')) {
            const config = vscode.workspace.getConfiguration('aspLanguageSupport');
            const enableSQL = config.get<boolean>('enableSqlInStrings', true);

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

        if (e.affectsConfiguration('aspLanguageSupport.disableHtml')) {
            const aspConfig = vscode.workspace.getConfiguration('aspLanguageSupport');
            const disableValidation = aspConfig.get<boolean>('disableHtml', true);
            const htmlConfig = vscode.workspace.getConfiguration('html');

            htmlConfig.update('validate.scripts', !disableValidation, vscode.ConfigurationTarget.Global).then(() => {
                console.log(`✅ HTML script validation ${disableValidation ? 'disabled' : 'enabled'}`);
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

    // Remove *.asp file association on uninstall/deactivate
    const filesConfig = vscode.workspace.getConfiguration('files');
    const associations: Record<string, string> = filesConfig.get('associations') ?? {};

    if (associations['*.asp'] === 'html') {
        delete associations['*.asp'];
        filesConfig.update('associations', associations, vscode.ConfigurationTarget.Global);
        console.log('✅ ASP file association removed');
    }

    // Re-enable HTML script validation
    vscode.workspace.getConfiguration('html').update(
        'validate.scripts',
        true,
        vscode.ConfigurationTarget.Global
    );
}