import * as vscode from "vscode";
import { getAspRegions } from "./region";
import { onSettingsChange, REGION_SETTING_KEYS, regionSettings, type RegionSettings } from "../platform/settings";

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
 * extension's subtle default) made a selection inside it disappear, and the
 * native selection sits beneath every decoration with no way to change that.
 *
 * So the tint is painted at half its strength over the selected part of a
 * region (see splitBySelections): the editor's own selection shows through as
 * it does everywhere else, still with a hint of "this is ASP code". Laying the
 * theme's selection colour on top of the full tint instead, as this once did,
 * counted the selection colour twice over a region and made it look brighter
 * there than anywhere else on the page.
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

/** The parts of `range` no selection covers, in order. */
export function outsideSelections(
    range: SimpleRange,
    selections: readonly SimpleRange[],
): SimpleRange[] {
    const covered = overlapWithSelections(range, selections).sort((a, b) => comparePos(a.start, b.start));
    const parts: SimpleRange[] = [];
    let from = range.start;
    for (const part of covered) {
        if (comparePos(from, part.start) < 0) { parts.push({ start: from, end: part.start }); }
        from = maxPos(from, part.end);
    }
    if (comparePos(from, range.end) < 0) { parts.push({ start: from, end: range.end }); }
    return parts;
}

/**
 * `ranges` split into what the selections leave alone and what they cover.
 * `ranges` are in document order and never overlap, so only the ones a
 * selection reaches are looked at closely; the rest go through as they are.
 * Undefined when no selection reaches any of them.
 */
export function splitBySelections<R extends SimpleRange>(
    ranges: readonly R[],
    selections: readonly SimpleRange[],
): { outside: SimpleRange[]; inside: SimpleRange[] } | undefined {
    const real = selections.filter(s => comparePos(s.start, s.end) !== 0);
    // The first range that ends after `at`.
    const firstEndingAfter = (at: Pos) => {
        let lo = 0, hi = ranges.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (comparePos(ranges[mid].end, at) <= 0) { lo = mid + 1; } else { hi = mid; } }
        return lo;
    };

    const touched = new Set<number>();
    for (const selection of real) {
        for (let i = firstEndingAfter(selection.start); i < ranges.length && comparePos(ranges[i].start, selection.end) < 0; i++) {
            touched.add(i);
        }
    }
    if (touched.size === 0) { return undefined; }

    const outside: SimpleRange[] = [];
    const inside: SimpleRange[] = [];
    ranges.forEach((range, i) => {
        if (!touched.has(i)) { outside.push(range); return; }
        outside.push(...outsideSelections(range, real));
        inside.push(...overlapWithSelections(range, real));
    });
    return { outside, inside };
}

/**
 * A CSS colour at half its opacity, for the tint over a selection: `#RGB`,
 * `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb()` and `rgba()`. Undefined for anything
 * else (a colour name, say); the selected part is then left untinted.
 */
export function halfAlpha(colour: string): string | undefined {
    const text = colour.trim();
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
    if (hex) {
        const digits = hex.length <= 4 ? [...hex].map(d => d + d).join('') : hex;
        const [r, g, b] = [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
        const a = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
        return `rgba(${r}, ${g}, ${b}, ${+(a / 2).toFixed(4)})`;
    }
    const fn = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(text);
    if (fn) {
        const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
        return `rgba(${fn[1]}, ${fn[2]}, ${fn[3]}, ${+(alpha / 2).toFixed(4)})`;
    }
    return undefined;
}

/** True when at least one selection in the editor covers real text. */
export function hasNonEmptySelection(selections: readonly { isEmpty: boolean }[]): boolean {
    return selections.some(selection => !selection.isEmpty);
}

/**
 * The editors the region colours go on: every Classic ASP page on screen. It
 * used to be the focused editor only — whatever its language — so with the
 * editor split the other page stayed unpainted until it was clicked.
 */
export function editorsToPaint<T extends { document: { languageId: string } }>(editors: readonly T[]): T[] {
    return editors.filter(editor => editor.document.languageId === 'asp');
}

interface Regions { version: number; brackets: vscode.Range[]; blocks: vscode.Range[] }

interface DecorationTypes {
    bracket:       vscode.TextEditorDecorationType;
    codeBlock:     vscode.TextEditorDecorationType;
    /** The same tints at half strength, over the selected part of a region. */
    bracketHalf:   vscode.TextEditorDecorationType;
    codeBlockHalf: vscode.TextEditorDecorationType;
}

export function addRegionHighlights(context: vscode.ExtensionContext) {
    let timeout: NodeJS.Timeout | null = null;
    let types: DecorationTypes | undefined;
    let configurationDidChange = false;

    // The regions a scan last found in each document. Selection changes fire
    // far more often than the document does — continuously while dragging — so
    // they replay these rather than rescanning, and a second editor on the same
    // page reuses them.
    const regionCache = new WeakMap<vscode.TextDocument, Regions>();

    // What each editor shows now: which regions, and whether a selection split
    // them. A caret moving with nothing selected — most selection events — then
    // costs nothing at all; decorations are sent to the renderer only when what
    // they show changes.
    const painted = new WeakMap<vscode.TextEditor, { regions: Regions; types: DecorationTypes; split: boolean }>();

    const aspEditors = () => editorsToPaint(vscode.window.visibleTextEditors);

    triggerUpdateDecorations();

    vscode.window.onDidChangeVisibleTextEditors(() => triggerUpdateDecorations(), null, context.subscriptions);

    vscode.window.onDidChangeTextEditorSelection((event) => {
        applyDecorations(event.textEditor);
    }, null, context.subscriptions);

    // Only the region settings rebuild the decoration types; any other change leaves them alone.
    context.subscriptions.push(onSettingsChange(REGION_SETTING_KEYS, () => {
        configurationDidChange = true;
        triggerUpdateDecorations();
    }));

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
            disposeTypes();
        },
    });

    function triggerUpdateDecorations() {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(updateDecorations, 200);
    }

    function disposeTypes() {
        if (!types) { return; }
        for (const type of Object.values(types)) { type.dispose(); }
        types = undefined;
    }

    function toVsRanges(ranges: readonly SimpleRange[]): vscode.Range[] {
        return ranges.map(r => new vscode.Range(
            new vscode.Position(r.start.line, r.start.character),
            new vscode.Position(r.end.line, r.end.character),
        ));
    }

    /**
     * Paints an editor's cached regions: in full where nothing is selected,
     * and at half strength over the part a selection covers. Runs on every
     * selection change, so it does nothing unless what is shown has to change.
     */
    function applyDecorations(editor: vscode.TextEditor) {
        const regions = regionCache.get(editor.document);
        if (!types || !regions) { return; }

        const selections = editor.selections.filter(s => !s.isEmpty);
        const brackets = splitBySelections(regions.brackets, selections);
        const blocks   = splitBySelections(regions.blocks, selections);
        const split    = brackets !== undefined || blocks !== undefined;

        const before = painted.get(editor);
        if (!split && before?.regions === regions && before.types === types && !before.split) { return; }

        editor.setDecorations(types.bracket,       brackets ? toVsRanges(brackets.outside) : regions.brackets);
        editor.setDecorations(types.codeBlock,     blocks ? toVsRanges(blocks.outside) : regions.blocks);
        editor.setDecorations(types.bracketHalf,   brackets ? toVsRanges(brackets.inside) : []);
        editor.setDecorations(types.codeBlockHalf, blocks ? toVsRanges(blocks.inside) : []);
        painted.set(editor, { regions, types, split });
    }

    function createTypes(colours: RegionSettings): DecorationTypes {
        const tint = (light: string, dark: string) => vscode.window.createTextEditorDecorationType({
            light: { backgroundColor: light },
            dark:  { backgroundColor: dark },
        });
        // A colour that cannot be halved leaves the selected part untinted.
        const half = (colour: string) => halfAlpha(colour) ?? 'transparent';
        return {
            bracket:       tint(colours.bracketLight, colours.bracketDark),
            codeBlock:     tint(colours.codeBlockLight, colours.codeBlockDark),
            bracketHalf:   tint(half(colours.bracketLight), half(colours.bracketDark)),
            codeBlockHalf: tint(half(colours.codeBlockLight), half(colours.codeBlockDark)),
        };
    }

    function updateDecorations() {
        const settings = regionSettings();

        // Only a settings change needs new decoration types (the colours are baked
        // into them). Disposing a type clears it from every editor, so the pages
        // on screen are all repainted below.
        if (configurationDidChange) {
            disposeTypes();
            configurationDidChange = false;
        }
        types ??= createTypes(settings);

        for (const editor of aspEditors()) {
            // Switching the feature off must actively clear what is already painted.
            if (!settings.enabled) {
                regionCache.delete(editor.document);
                painted.delete(editor);
                for (const type of Object.values(types)) { editor.setDecorations(type, []); }
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
