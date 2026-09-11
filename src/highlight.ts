import * as vscode from "vscode";
import { getAspRegions } from "./utils/region";

/**
 * True when at least one selection in the editor covers real text.
 *
 * A TextEditorDecorationType's backgroundColor is painted on the same layer as
 * the text itself, above VS Code's own selection highlight — so a codeBlock
 * colour with enough opacity (a user's own, more visible choice, not this
 * extension's subtle default) makes a selection inside it disappear. There is
 * no way to ask the renderer to draw decorations behind the selection instead,
 * so the fix is to stop painting the decoration wherever a selection exists.
 *
 * Typed against a minimal shape rather than vscode.Selection so it can be unit
 * tested without any of the editor machinery around it.
 */
export function hasNonEmptySelection(selections: readonly { isEmpty: boolean }[]): boolean {
    return selections.some(selection => !selection.isEmpty);
}

export function addRegionHighlights(context: vscode.ExtensionContext) {
    // Declare all variables at the top of the function
    let timeout: NodeJS.Timeout | null = null;
    let bracketDecorationType: vscode.TextEditorDecorationType;
    let codeBlockDecorationType: vscode.TextEditorDecorationType;
    let configurationDidChange = false;

    // The last regions a real document scan produced. Selection changes fire
    // far more often than the document does — continuously while dragging —
    // so toggling visibility replays these cached ranges rather than rescanning.
    let lastBrackets: vscode.Range[] = [];
    let lastBlocks: vscode.Range[] = [];

    let activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) triggerUpdateDecorations();

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        activeEditor = editor;
        if (editor) triggerUpdateDecorations();
    }, null, context.subscriptions);

    // Hides the decorations while a selection would be painted over, and
    // restores them the moment every selection collapses back to a caret.
    vscode.window.onDidChangeTextEditorSelection((event) => {
        if (activeEditor && event.textEditor === activeEditor) {
            applyDecorations();
        }
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

    /**
     * Paints the last computed regions, unless a selection would be painted
     * over — in which case it paints nothing instead. Cheap enough to run on
     * every selection-change event, since it never rescans the document.
     */
    function applyDecorations() {
        if (!activeEditor || !bracketDecorationType || !codeBlockDecorationType) { return; }

        const hide = hasNonEmptySelection(activeEditor.selections);
        activeEditor.setDecorations(bracketDecorationType, hide ? [] : lastBrackets);
        activeEditor.setDecorations(codeBlockDecorationType, hide ? [] : lastBlocks);
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

        // Only a settings change needs new decoration types (the colours are baked
        // into them). This used to fire on `!highlightAspRegions` too, so with the
        // feature switched OFF both types were disposed and recreated on every
        // update tick — once per keystroke, for a feature that is not running.
        if (configurationDidChange) {
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
            lastBrackets = [];
            lastBlocks   = [];
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

        // Cached so a later selection change can toggle visibility without
        // rescanning the document. Always assigned, even when empty — returning
        // early on an empty region list left the PREVIOUS run's tint painted over
        // whatever text had shifted into those lines — delete the last <% %>
        // block and the highlight stayed behind until the editor was switched
        // away and back.
        lastBrackets = brackets;
        lastBlocks   = blocks;
        applyDecorations();
    }
}
