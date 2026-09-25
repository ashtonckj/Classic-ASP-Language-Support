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
 * The parts of `range` that a current selection covers.
 *
 * A TextEditorDecorationType's backgroundColor is painted on the same layer as
 * the text itself, above VS Code's own selection highlight — so a codeBlock
 * colour with enough opacity (a user's own, more visible choice, not this
 * extension's subtle default) made a selection inside it disappear, because
 * the ASP tint painted right over it, and the native selection sits beneath
 * every decoration with no way to change that.
 *
 * Rather than removing the ASP tint wherever a selection overlaps it — which
 * loses the "this is ASP code" cue for exactly the text someone is looking at,
 * and is a bad trade for anyone who spends most of their time selecting text
 * inside <% %> blocks — the overlap is given its OWN decoration, using the
 * theme's real selection colour (see the selectionOverlay type below),
 * layered on top of the tint rather than in place of it. Two translucent
 * layers on the same characters blend, so the result carries both signals:
 * still tinted as ASP code, and visibly selected. The tint itself is always
 * painted in full, everywhere, regardless of any selection.
 *
 * Written against a minimal structural shape rather than vscode.Range/Position
 * so it can be unit tested without any editor machinery, and works unchanged
 * whether it is handed real vscode objects or plain {line, character} data.
 */
export function overlapWithSelections(
    range: SimpleRange,
    selections: readonly SimpleRange[],
): SimpleRange[] {
    const overlaps: SimpleRange[] = [];

    for (const selection of selections) {
        if (comparePos(selection.start, selection.end) === 0) { continue; } // an empty selection covers nothing

        const start = maxPos(range.start, selection.start);
        const end   = minPos(range.end, selection.end);
        if (comparePos(start, end) < 0) {
            overlaps.push({ start, end });
        }
    }

    return overlaps;
}

/** True when at least one selection in the editor covers real text. */
export function hasNonEmptySelection(selections: readonly { isEmpty: boolean }[]): boolean {
    return selections.some(selection => !selection.isEmpty);
}

const REGION_SETTINGS = [
    'aspLanguageSupport.highlightAspRegions',
    'aspLanguageSupport.bracketLightColor',
    'aspLanguageSupport.bracketDarkColor',
    'aspLanguageSupport.codeBlockLightColor',
    'aspLanguageSupport.codeBlockDarkColor',
];

/**
 * True when a settings change touches the region colours or switches them on
 * or off. Every settings change, of any kind, used to throw away and rebuild
 * the decoration types.
 */
export function affectsRegionHighlight(event: { affectsConfiguration(section: string): boolean }): boolean {
    return REGION_SETTINGS.some(setting => event.affectsConfiguration(setting));
}

/**
 * The editors the region colours go on: every Classic ASP page on screen. It
 * used to be the focused editor only — whatever its language — so with the
 * editor split the other page stayed unpainted until it was clicked.
 */
export function editorsToPaint<T extends { document: { languageId: string } }>(editors: readonly T[]): T[] {
    return editors.filter(editor => editor.document.languageId === 'asp');
}

export function addRegionHighlights(context: vscode.ExtensionContext) {
    let timeout: NodeJS.Timeout | null = null;
    let bracketDecorationType: vscode.TextEditorDecorationType | undefined;
    let codeBlockDecorationType: vscode.TextEditorDecorationType | undefined;
    // Painted on top of the ASP tint, over exactly the part of a region a
    // selection covers, using the theme's own selection colour — see
    // overlapWithSelections for why this layers over the tint rather than
    // replacing it.
    let selectionOverlayDecorationType: vscode.TextEditorDecorationType | undefined;
    let configurationDidChange = false;

    // The regions a scan last found in each document. Selection changes fire
    // far more often than the document does — continuously while dragging — so
    // they replay these rather than rescanning, and a second editor on the same
    // page reuses them.
    const regionCache = new WeakMap<vscode.TextDocument, { version: number; brackets: vscode.Range[]; blocks: vscode.Range[] }>();

    const aspEditors = () => editorsToPaint(vscode.window.visibleTextEditors);

    triggerUpdateDecorations();

    vscode.window.onDidChangeVisibleTextEditors(() => triggerUpdateDecorations(), null, context.subscriptions);

    // Re-checks the cached regions against the new selection state, and clears
    // the overlay the moment every selection collapses back to a caret.
    vscode.window.onDidChangeTextEditorSelection((event) => {
        applyDecorations(event.textEditor);
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeConfiguration((event) => {
        if (!affectsRegionHighlight(event)) { return; }
        configurationDidChange = true;
        triggerUpdateDecorations();
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId === 'asp' && vscode.window.visibleTextEditors.some(e => e.document === event.document)) {
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
     * Paints an editor's cached regions in full — the ASP tint is never removed
     * by a selection — then adds the selection-coloured overlay on top of
     * whatever part of those regions a selection actually covers. Cheap enough
     * to run on every selection-change event, since it never rescans the
     * document and the overlap check only visits the (typically small) list of
     * cached regions, not the whole file.
     */
    function applyDecorations(editor: vscode.TextEditor) {
        if (!bracketDecorationType || !codeBlockDecorationType || !selectionOverlayDecorationType) { return; }
        const regions = regionCache.get(editor.document);
        if (!regions) { return; }

        editor.setDecorations(bracketDecorationType, regions.brackets);
        editor.setDecorations(codeBlockDecorationType, regions.blocks);

        const selections = editor.selections.filter(s => !s.isEmpty);
        if (selections.length === 0) {
            editor.setDecorations(selectionOverlayDecorationType, []);
            return;
        }

        const overlay: vscode.Range[] = [];
        for (const range of [...regions.brackets, ...regions.blocks]) {
            overlay.push(...toVsRanges(overlapWithSelections(range, selections)));
        }
        editor.setDecorations(selectionOverlayDecorationType, overlay);
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
        const config = vscode.workspace.getConfiguration("aspLanguageSupport");
        const highlightAspRegions = config.get<boolean>("highlightAspRegions", true);

        // Only a settings change needs new decoration types (the colours are baked
        // into them). Disposing a type clears it from every editor, so the pages
        // on screen are all repainted below.
        if (configurationDidChange) {
            bracketDecorationType?.dispose();
            codeBlockDecorationType?.dispose();
            selectionOverlayDecorationType?.dispose();
            bracketDecorationType = undefined;
            configurationDidChange = false;
        }
        if (!bracketDecorationType || !codeBlockDecorationType || !selectionOverlayDecorationType) {
            setDecorationTypes(config);
        }

        for (const editor of aspEditors()) {
            // Switching the feature off must actively clear what is already painted.
            if (!highlightAspRegions) {
                regionCache.delete(editor.document);
                editor.setDecorations(bracketDecorationType!, []);
                editor.setDecorations(codeBlockDecorationType!, []);
                editor.setDecorations(selectionOverlayDecorationType!, []);
                continue;
            }

            // Always stored, even when empty — keeping the previous scan left the
            // old tint painted over whatever text had shifted into those lines
            // when the last <% %> block was deleted.
            const document = editor.document;
            const cached = regionCache.get(document);
            if (!cached || cached.version !== document.version) {
                const brackets: vscode.Range[] = [];
                const blocks: vscode.Range[] = [];
                for (const region of getAspRegions(document)) {
                    brackets.push(region.openingBracket);
                    blocks.push(region.codeBlock);
                    brackets.push(region.closingBracket);
                }
                regionCache.set(document, { version: document.version, brackets, blocks });
            }
            applyDecorations(editor);
        }
    }
}
