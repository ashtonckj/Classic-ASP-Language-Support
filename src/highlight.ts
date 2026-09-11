import * as vscode from "vscode";
import { getAspRegions } from "./utils/region";

/** A line/character pair — matches the shape of vscode.Position exactly. */
interface Pos { line: number; character: number; }

/** A start/end pair — matches the shape of vscode.Range exactly. */
interface SimpleRange { start: Pos; end: Pos; }

function comparePos(a: Pos, b: Pos): number {
    return a.line !== b.line ? a.line - b.line : a.character - b.character;
}
function maxPos(a: Pos, b: Pos): Pos { return comparePos(a, b) >= 0 ? a : b; }
function minPos(a: Pos, b: Pos): Pos { return comparePos(a, b) <= 0 ? a : b; }

/**
 * Splits `range` into the parts no current selection touches, and the parts
 * that overlap a selection.
 *
 * A TextEditorDecorationType's backgroundColor is painted on the same layer as
 * the text itself, above VS Code's own selection highlight — so a codeBlock
 * colour with enough opacity (a user's own, more visible choice, not this
 * extension's subtle default) made a selection inside it disappear, because
 * the ASP tint painted right over it. There is no way to ask the renderer to
 * draw a decoration behind the selection instead.
 *
 * Rather than hiding the whole region — or worse, every region in the file —
 * the moment ANY selection exists anywhere, this carves out just the part that
 * actually overlaps a selection. That part is later given its own decoration
 * using the theme's real selection colour (see SELECTION_OVERLAY below), so it
 * still reads as a normal selection; everything else keeps its ASP tint,
 * including every other <% %> block in the file that the selection never
 * touches.
 *
 * Written against a minimal structural shape rather than vscode.Range/Position
 * so it can be unit tested without any editor machinery, and works unchanged
 * whether it is handed real vscode objects or plain {line, character} data.
 */
export function splitByOverlap(
    range: SimpleRange,
    selections: readonly SimpleRange[],
): { unselected: SimpleRange[]; selected: SimpleRange[] } {
    let remaining: SimpleRange[] = [{ start: range.start, end: range.end }];
    const selected: SimpleRange[] = [];

    for (const selection of selections) {
        if (comparePos(selection.start, selection.end) === 0) { continue; } // an empty selection covers nothing

        const next: SimpleRange[] = [];
        for (const piece of remaining) {
            const overlapStart = maxPos(piece.start, selection.start);
            const overlapEnd   = minPos(piece.end, selection.end);

            if (comparePos(overlapStart, overlapEnd) >= 0) {
                next.push(piece); // no overlap with this selection
                continue;
            }

            selected.push({ start: overlapStart, end: overlapEnd });
            if (comparePos(piece.start, overlapStart) < 0) {
                next.push({ start: piece.start, end: overlapStart }); // the part before the overlap
            }
            if (comparePos(overlapEnd, piece.end) < 0) {
                next.push({ start: overlapEnd, end: piece.end }); // the part after the overlap
            }
        }
        remaining = next;
    }

    return { unselected: remaining, selected };
}

/** True when at least one selection in the editor covers real text. */
export function hasNonEmptySelection(selections: readonly { isEmpty: boolean }[]): boolean {
    return selections.some(selection => !selection.isEmpty);
}

export function addRegionHighlights(context: vscode.ExtensionContext) {
    // Declare all variables at the top of the function
    let timeout: NodeJS.Timeout | null = null;
    let bracketDecorationType: vscode.TextEditorDecorationType;
    let codeBlockDecorationType: vscode.TextEditorDecorationType;
    // Stands in for the part of a region a selection covers, using the theme's
    // own selection colour rather than this extension's ASP tint — see
    // splitByOverlap for why the tint cannot simply be layered under it.
    let selectionOverlayDecorationType: vscode.TextEditorDecorationType;
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

    // Re-splits the cached regions against the new selection state, and
    // restores plain ASP tinting the moment every selection collapses back to
    // a caret.
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
    // set is current at shutdown.
    context.subscriptions.push({
        dispose: () => {
            if (timeout) { clearTimeout(timeout); }
            bracketDecorationType?.dispose();
            codeBlockDecorationType?.dispose();
            selectionOverlayDecorationType?.dispose();
        },
    });

    function triggerUpdateDecorations() {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(updateDecorations, 200);
    }

    function toVsRanges(ranges: readonly SimpleRange[]): vscode.Range[] {
        return ranges.map(r => new vscode.Range(
            new vscode.Position(r.start.line, r.start.character),
            new vscode.Position(r.end.line, r.end.character),
        ));
    }

    /**
     * Paints the last computed regions, splitting each one against the current
     * selections so only the part a selection actually covers switches to the
     * selection-coloured overlay — every other part, and every region the
     * selection never touches, keeps its normal ASP tint. Cheap enough to run
     * on every selection-change event, since it never rescans the document.
     */
    function applyDecorations() {
        if (!activeEditor || !bracketDecorationType || !codeBlockDecorationType
            || !selectionOverlayDecorationType) { return; }

        const selections = activeEditor.selections.filter(s => !s.isEmpty);

        if (selections.length === 0) {
            activeEditor.setDecorations(bracketDecorationType, lastBrackets);
            activeEditor.setDecorations(codeBlockDecorationType, lastBlocks);
            activeEditor.setDecorations(selectionOverlayDecorationType, []);
            return;
        }

        const brackets: vscode.Range[] = [];
        const blocks:   vscode.Range[] = [];
        const overlay:  vscode.Range[] = [];

        for (const range of lastBrackets) {
            const split = splitByOverlap(range, selections);
            brackets.push(...toVsRanges(split.unselected));
            overlay.push(...toVsRanges(split.selected));
        }
        for (const range of lastBlocks) {
            const split = splitByOverlap(range, selections);
            blocks.push(...toVsRanges(split.unselected));
            overlay.push(...toVsRanges(split.selected));
        }

        activeEditor.setDecorations(bracketDecorationType, brackets);
        activeEditor.setDecorations(codeBlockDecorationType, blocks);
        activeEditor.setDecorations(selectionOverlayDecorationType, overlay);
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
        // A ThemeColor resolves to whatever the ACTIVE theme's real selection
        // colour is, light or dark alike, so there is no separate light/dark
        // pair to configure here the way the two tints above need one.
        selectionOverlayDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
        });
    }

    function updateDecorations() {
        if (!activeEditor) return;

        const config = vscode.workspace.getConfiguration("aspLanguageSupport");
        const highlightAspRegions = config.get<boolean>("highlightAspRegions", true);

        // Create our decoration types
        if (!bracketDecorationType || !codeBlockDecorationType || !selectionOverlayDecorationType) {
            setDecorationTypes(config);
        }

        // Only a settings change needs new decoration types (the colours are baked
        // into them). This used to fire on `!highlightAspRegions` too, so with the
        // feature switched OFF both types were disposed and recreated on every
        // update tick — once per keystroke, for a feature that is not running.
        if (configurationDidChange) {
            bracketDecorationType?.dispose();
            codeBlockDecorationType?.dispose();
            selectionOverlayDecorationType?.dispose();
            setDecorationTypes(config);

            configurationDidChange = false;
        }

        // Switching the feature off must actively clear what is already painted.
        if (!highlightAspRegions) {
            lastBrackets = [];
            lastBlocks   = [];
            activeEditor.setDecorations(bracketDecorationType, []);
            activeEditor.setDecorations(codeBlockDecorationType, []);
            activeEditor.setDecorations(selectionOverlayDecorationType, []);
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

        // Cached so a later selection change can re-split without rescanning the
        // document. Always assigned, even when empty — returning early on an
        // empty region list left the PREVIOUS run's tint painted over whatever
        // text had shifted into those lines — delete the last <% %> block and
        // the highlight stayed behind until the editor was switched away and back.
        lastBrackets = brackets;
        lastBlocks   = blocks;
        applyDecorations();
    }
}
