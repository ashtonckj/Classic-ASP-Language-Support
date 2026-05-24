import * as vscode from "vscode";
import { getAspRegions } from "./region";

export function addRegionHighlights(context: vscode.ExtensionContext) {
    // Declare all variables at the top of the function
    let timeout: NodeJS.Timeout | null = null;
    let bracketDecorationType: vscode.TextEditorDecorationType;
    let codeBlockDecorationType: vscode.TextEditorDecorationType;
    let configurationDidChange = false;

    let activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        triggerUpdateDecorations();
    }

    vscode.window.onDidChangeActiveTextEditor(
        (editor) => {
            activeEditor = editor;
            if (editor) {
                triggerUpdateDecorations();
            }
        },
        null,
        context.subscriptions,
    );

    vscode.workspace.onDidChangeConfiguration(() => {
        configurationDidChange = true;
        triggerUpdateDecorations();
    });

    vscode.workspace.onDidChangeTextDocument(
        (event) => {
            if (activeEditor && event.document === activeEditor.document) {
                triggerUpdateDecorations();
            }
        },
        null,
        context.subscriptions,
    );

    function triggerUpdateDecorations() {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(updateDecorations, 200);
    }

    function setDecorationTypes(config: vscode.WorkspaceConfiguration) {
        const bracketLightColor = config.get<string>("bracketLightColor");
        const bracketDarkColor = config.get<string>("bracketDarkColor");
        const codeBlockLightColor = config.get<string>("codeBlockLightColor");
        const codeBlockDarkColor = config.get<string>("codeBlockDarkColor");

        bracketDecorationType = vscode.window.createTextEditorDecorationType({
            light: {
                backgroundColor: bracketLightColor,
            },
            dark: {
                backgroundColor: bracketDarkColor,
            },
        });

        codeBlockDecorationType = vscode.window.createTextEditorDecorationType({
            light: {
                backgroundColor: codeBlockLightColor,
            },
            dark: {
                backgroundColor: codeBlockDarkColor,
            },
        });
    }

    function updateDecorations() {
        if (!activeEditor) {
            return;
        }

        const config = vscode.workspace.getConfiguration("aspLanguageSupport");
        const highlightAspRegions: boolean = config.get<boolean>(
            "highlightAspRegions",
            true,
        );

        // Create our decoration types
        if (!bracketDecorationType || !codeBlockDecorationType) {
            setDecorationTypes(config);
        }

        if (configurationDidChange || !highlightAspRegions) {
            if (bracketDecorationType) {
                bracketDecorationType.dispose();
            }
            if (codeBlockDecorationType) {
                codeBlockDecorationType.dispose();
            }
            setDecorationTypes(config);

            configurationDidChange = false;
        }

        if (!highlightAspRegions) {
            return;
        }

        const regions = getAspRegions(activeEditor.document);

        if (!regions || regions.length === 0) {
            return;
        }

        const blocks: vscode.Range[] = [];
        const brackets: vscode.Range[] = [];

        for (const region of regions) {
            brackets.push(region.openingBracket);
            blocks.push(region.codeBlock);
            brackets.push(region.closingBracket);
        }

        activeEditor.setDecorations(bracketDecorationType, brackets);
        activeEditor.setDecorations(codeBlockDecorationType, blocks);
    }
}
