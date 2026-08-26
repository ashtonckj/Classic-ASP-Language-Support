import * as vscode from "vscode";
import { getAspRegions } from "./utils/region";

export function addRegionHighlights(context: vscode.ExtensionContext) {
    // Declare all variables at the top of the function
    let timeout: NodeJS.Timeout | null = null;
    let bracketDecorationType: vscode.TextEditorDecorationType;
    let codeBlockDecorationType: vscode.TextEditorDecorationType;
    let configurationDidChange = false;

    let activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) triggerUpdateDecorations();

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        activeEditor = editor;
        if (editor) triggerUpdateDecorations();
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeConfiguration(() => {
        configurationDidChange = true;
        triggerUpdateDecorations();
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument((event) => {
        if (activeEditor && event.document === activeEditor.document) {
            triggerUpdateDecorations();
        }
    }, null, context.subscriptions);

    // Release the decoration types (and any pending timer) on deactivate. They are
    // recreated inside updateDecorations on config change, so dispose whichever
    // pair is current at shutdown.
    context.subscriptions.push({
        dispose: () => {
            if (timeout) { clearTimeout(timeout); }
            bracketDecorationType?.dispose();
            codeBlockDecorationType?.dispose();
        },
    });

    function triggerUpdateDecorations() {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(updateDecorations, 200);
    }

    function setDecorationTypes(config: vscode.WorkspaceConfiguration) {
        bracketDecorationType = vscode.window.createTextEditorDecorationType({
            light: { backgroundColor: config.get<string>("bracketLightColor") },
            dark:  { backgroundColor: config.get<string>("bracketDarkColor") },
        });
        codeBlockDecorationType = vscode.window.createTextEditorDecorationType({
            light: { backgroundColor: config.get<string>("codeBlockLightColor") },
            dark:  { backgroundColor: config.get<string>("codeBlockDarkColor") },
        });
    }

    function updateDecorations() {
        if (!activeEditor) return;

        const config = vscode.workspace.getConfiguration("aspLanguageSupport");
        const highlightAspRegions = config.get<boolean>("highlightAspRegions", true);

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

        // Switching the feature off must actively clear what is already painted.
        if (!highlightAspRegions) {
            activeEditor.setDecorations(bracketDecorationType, []);
            activeEditor.setDecorations(codeBlockDecorationType, []);
            return;
        }

        const regions = getAspRegions(activeEditor.document);

        const blocks: vscode.Range[] = [];
        const brackets: vscode.Range[] = [];

        for (const region of regions) {
            brackets.push(region.openingBracket);
            blocks.push(region.codeBlock);
            brackets.push(region.closingBracket);
        }

        // Always call setDecorations, even with empty arrays. Returning early on
        // an empty region list left the PREVIOUS run's tint painted over whatever
        // text had shifted into those lines — delete the last <% %> block and the
        // highlight stayed behind until the editor was switched away and back.
        activeEditor.setDecorations(bracketDecorationType, brackets);
        activeEditor.setDecorations(codeBlockDecorationType, blocks);
    }
}
