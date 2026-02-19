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

    // Keep setLanguageConfiguration as a fallback (may or may not work depending on VS Code version)
    vscode.languages.setLanguageConfiguration('html', {
        indentationRules: {
            increaseIndentPattern: /^\s*(If\b.*\bThen\s*$|ElseIf\b.*\bThen\s*$|Else\s*$|For\b.*\bTo\b.*$|For\s+Each\b.*\bIn\b.*$|Do\s*$|Do\s+(While|Until)\b.*$|While\b.*$|Select\s+Case\b.*$|Case\b.*$|Sub\s+\w.*$|Function\s+\w.*$|Class\s+\w.*$|With\s+\w.*$|Property\s+(Get|Let|Set)\b.*$)/i,
            decreaseIndentPattern: /^\s*(End\s+(If|Sub|Function|Select|With|Class|Property)\b|Next\b|Loop\b|Wend\b|ElseIf\b|Else\s*$|Case\b)/i
        },
        onEnterRules: [
            {
                beforeText: /^\s*(?:If\s+.+\s+Then|For\s+.+\s+To.+|For\s+Each\s+.+\s+In.+|Do|Do\s+(?:While|Until).+|While\s+.+|Select\s+Case\s+.+|Sub\s+\w[^']*|Function\s+\w[^']*|Class\s+\w[^']*|With\s+\S+|Property\s+(?:Get|Let|Set)\s+\w[^']*)\s*$/i,
                action: { indentAction: vscode.IndentAction.Indent }
            },
            {
                beforeText: /^\s*(?:Else|ElseIf\s+.+\s+Then)\s*$/i,
                action: { indentAction: vscode.IndentAction.IndentOutdent }
            },
            {
                beforeText: /^\s*(?:Case(?:\s+Else|\s+.+))\s*$/i,
                action: { indentAction: vscode.IndentAction.IndentOutdent }
            }
        ]
    });
    console.log('✅ VBScript indent rules applied to html language');

    // ─── Enter key intercept for .asp files ──────────────────────────────────
    // VS Code's built-in HTML language extension often overwrites setLanguageConfiguration,
    // so we intercept Enter directly to guarantee correct VBScript indentation.

    // Patterns that increase indent on the NEXT line
    const increasePatterns = /^\s*(?:If\s+.+\s+Then|For\s+.+\s+To.+|For\s+Each\s+.+\s+In.+|Do|Do\s+(?:While|Until).+|While\s+.+|Select\s+Case\s+.+|Sub\s+\w[^']*|Function\s+\w[^']*|Class\s+\w[^']*|With\s+\S+|Property\s+(?:Get|Let|Set)\s+\w[^']*)\s*$/i;

    // Patterns that dedent the CURRENT line and then indent the next
    // (Else, ElseIf, Case — they sit one level back from their block content)
    const outdentThenIndentPatterns = /^\s*(?:Else|ElseIf\s+.+\s+Then|Case(?:\s+Else|\s+.+))\s*$/i;

    // Patterns that are block-closers — they should already be dedented by decreaseIndentPattern
    // so just insert a newline at the same level
    const decreasePatterns = /^\s*(?:End\s+(?:If|Sub|Function|Select|With|Class|Property)|Next|Loop|Wend)\s*$/i;

    const enterKeyHandler = vscode.commands.registerTextEditorCommand(
        'asp.handleEnterKey',
        (editor: vscode.TextEditor) => {
            const doc = editor.document;

            if (!doc.fileName.endsWith('.asp')) {
                vscode.commands.executeCommand('default:type', { text: '\n' });
                return;
            }

            const position = editor.selection.active;

            // Check if cursor is inside a <% %> block by scanning backwards
            const textUpToCursor = doc.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const lastOpen = textUpToCursor.lastIndexOf('<%');
            const lastClose = textUpToCursor.lastIndexOf('%>');
            const insideAspBlock = lastOpen > lastClose;

            // If not inside a <% %> block, let VS Code handle it normally
            if (!insideAspBlock) {
                const lineText = doc.lineAt(position.line).text;
                const textBeforeCursor = lineText.substring(0, position.character);
                const textAfterCursor = lineText.substring(position.character);
                const currentIndent = lineText.match(/^\s*/)?.[0] ?? '';
                const indentUnit = editor.options.insertSpaces
                    ? ' '.repeat(editor.options.tabSize as number)
                    : '\t';

                // Check for <tag>| pattern — opening tag right before cursor with closing tag after
                const openTagBefore = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*>$/.test(textBeforeCursor);
                const closeTagAfter = /^<\/[a-zA-Z]/.test(textAfterCursor);

                if (openTagBefore && closeTagAfter) {
                    // Wrap: newline + indent, then newline + closing tag at original indent
                    editor.edit(editBuilder => {
                        editBuilder.insert(position, '\n' + currentIndent + indentUnit + '\n' + currentIndent);
                    }).then(() => {
                        // Place cursor on the indented middle line
                        const newPos = new vscode.Position(position.line + 1, (currentIndent + indentUnit).length);
                        editor.selection = new vscode.Selection(newPos, newPos);
                    });
                    return;
                }

                // Everything else outside ASP block — let VS Code handle it
                vscode.commands.executeCommand('default:type', { text: '\n' });
                return;
            }

            const lineText = doc.lineAt(position.line).text;
            const textBeforeCursor = lineText.substring(0, position.character);
            const currentIndent = lineText.match(/^\s*/)?.[0] ?? '';

            const indentUnit = editor.options.insertSpaces
                ? ' '.repeat(editor.options.tabSize as number)
                : '\t';

            if (outdentThenIndentPatterns.test(textBeforeCursor)) {
                const dedentedIndent = currentIndent.startsWith(indentUnit)
                    ? currentIndent.slice(indentUnit.length)
                    : currentIndent;

                const trimmed = lineText.trimStart();
                const lineRange = doc.lineAt(position.line).range;

                editor.edit(editBuilder => {
                    editBuilder.replace(lineRange, dedentedIndent + trimmed + '\n' + dedentedIndent + indentUnit);
                }).then(() => {
                    const newLine = position.line + 1;
                    const newLineText = doc.lineAt(newLine).text;
                    const newPos = new vscode.Position(newLine, newLineText.length);
                    editor.selection = new vscode.Selection(newPos, newPos);
                });

            } else if (increasePatterns.test(textBeforeCursor)) {
                editor.edit(editBuilder => {
                    editBuilder.insert(position, '\n' + currentIndent + indentUnit);
                }).then(() => {
                    const newLine = position.line + 1;
                    const newLineText = doc.lineAt(newLine).text;
                    const newPos = new vscode.Position(newLine, newLineText.length);
                    editor.selection = new vscode.Selection(newPos, newPos);
                });

            } else {
                editor.edit(editBuilder => {
                    editBuilder.insert(position, '\n' + currentIndent);
                }).then(() => {
                    const newLine = position.line + 1;
                    const newLineText = doc.lineAt(newLine).text;
                    const newPos = new vscode.Position(newLine, newLineText.length);
                    editor.selection = new vscode.Selection(newPos, newPos);
                });
            }
        }
    );
    console.log('✅ Enter key handler registered for .asp files');
    // ─────────────────────────────────────────────────────────────────────────

    const dedentWatcher = vscode.workspace.onDidChangeTextDocument(event => {
        const doc = event.document;
        if (!doc.fileName.endsWith('.asp')) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== doc) return;

        const dedentKeywords = /^\s*(End\s+If|End\s+Sub|End\s+Function|End\s+Select|End\s+With|End\s+Class|End\s+Property|Next|Loop|Wend)\s*$/i;

        // Map each closing keyword to its matching opener(s)
        const matchingOpener: Record<string, RegExp> = {
            'end if':       /^\s*(?:If\s+.+\s+Then|ElseIf\s+.+\s+Then|Else\s*$)/i,
            'end sub':      /^\s*Sub\s+\w/i,
            'end function': /^\s*Function\s+\w/i,
            'end select':   /^\s*Select\s+Case\b/i,
            'end with':     /^\s*With\s+\S/i,
            'end class':    /^\s*Class\s+\w/i,
            'end property': /^\s*Property\s+(?:Get|Let|Set)\b/i,
            'next':         /^\s*For\b/i,
            'loop':         /^\s*Do\b/i,
            'wend':         /^\s*While\b/i,
        };

        for (const change of event.contentChanges) {
            const typedChar = change.text;
            if (typedChar.length !== 1 || /\s/.test(typedChar)) continue;

            const lineNum = change.range.start.line;
            const line = doc.lineAt(lineNum);
            const lineText = line.text;

            if (!dedentKeywords.test(lineText)) continue;

            // Figure out which keyword we matched
            const keyword = Object.keys(matchingOpener).find(k =>
                new RegExp('^\\s*' + k + '\\s*$', 'i').test(lineText)
            );
            if (!keyword) continue;

            const openerPattern = matchingOpener[keyword];

            // Scan upwards to find the matching opener
            let matchIndent: string | null = null;
            let depth = 0;

            for (let i = lineNum - 1; i >= 0; i--) {
                const upText = doc.lineAt(i).text;

                // If we hit another closer of the same type, we need to skip its opener too
                if (dedentKeywords.test(upText) &&
                    new RegExp('^\\s*' + keyword + '\\s*$', 'i').test(upText)) {
                    depth++;
                    continue;
                }

                if (openerPattern.test(upText)) {
                    if (depth > 0) {
                        depth--;
                        continue;
                    }
                    matchIndent = upText.match(/^\s*/)?.[0] ?? '';
                    break;
                }
            }

            if (matchIndent === null) continue;

            const currentIndent = lineText.match(/^\s*/)?.[0] ?? '';
            if (currentIndent === matchIndent) continue; // already correct, nothing to do

            const trimmed = lineText.trimStart();

            editor.edit(editBuilder => {
                editBuilder.replace(line.range, matchIndent + trimmed);
            }).then(() => {
                const newPos = new vscode.Position(lineNum, (matchIndent! + trimmed).length);
                editor.selection = new vscode.Selection(newPos, newPos);
            });

            break;
        }
    });

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
        configWatcher,
        enterKeyHandler,
        dedentWatcher
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