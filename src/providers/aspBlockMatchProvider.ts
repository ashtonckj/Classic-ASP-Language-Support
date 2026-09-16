import * as vscode from 'vscode';
import { getMatchedBlockPairs, BlockPair } from './aspStructureDiagnosticsProvider';

// ─────────────────────────────────────────────────────────────────────────────
// aspBlockMatchProvider.ts
//
// VBScript has no braces, so its block keywords never get the highlight VS Code
// paints over a matching `{ }` pair. This gives them the same treatment: put
// the caret on `If` (or `Do`, `Sub`, `Select Case`, ...) and its `End If` lights
// up the way a `{` lights up its `}`.
//
// The pairing itself comes from aspStructureDiagnosticsProvider, which already
// computes it to report MISmatches — reusing that scan means the highlight and
// the diagnostics can never disagree about how a file's blocks nest.
// ─────────────────────────────────────────────────────────────────────────────

// Cached by document version. A rescan walks every line of the file, so it
// must never run on every keystroke — onDidChangeTextEditorSelection fires
// once per cursor move, and a `type` command moves the cursor AND bumps the
// version in the same tick, so naively rescanning there added a synchronous
// full-document scan to every character typed anywhere in an .asp file. That
// was enough to starve other listeners on the same event loop turn (a real,
// observed regression in this extension's own auto-close-tag handler under
// load) for a highlight nobody was even looking at yet. The 200ms debounce
// below mirrors highlight.ts's own region-tint rescan for the same reason.
interface PairCache { version: number; pairs: BlockPair[]; }
const _pairCache = new Map<string, PairCache>();

/** Always correct: rescans if the cache is stale. Only for LOW-frequency call sites (a tab switch, the debounced rescan) — never for a per-keystroke event. */
function getPairsFresh(document: vscode.TextDocument): BlockPair[] {
    const key = document.uri.toString();
    const cached = _pairCache.get(key);
    if (cached && cached.version === document.version) { return cached.pairs; }

    const pairs = getMatchedBlockPairs(document);
    _pairCache.set(key, { version: document.version, pairs });
    return pairs;
}

/** Cheap: whatever's already cached, or nothing while a debounced rescan is still pending. Safe to call on every selection change. */
function getPairsCachedOnly(document: vscode.TextDocument): BlockPair[] {
    const cached = _pairCache.get(document.uri.toString());
    return cached && cached.version === document.version ? cached.pairs : [];
}

/** The pair whose opener or closer range contains `position`, if any. */
function findPairAt(pairs: BlockPair[], position: vscode.Position): BlockPair | undefined {
    return pairs.find(p => p.opener.range.contains(position) || p.closer.range.contains(position));
}

export function registerAspBlockMatch(context: vscode.ExtensionContext): void {
    // Same colours VS Code paints its own `{ }` bracket match with, so this
    // reads as "the same feature, just for keywords" rather than a new one.
    const decoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editorBracketMatch.background'),
        border: '1px solid',
        borderColor: new vscode.ThemeColor('editorBracketMatch.border'),
    });

    // Selection-change path: cheap lookup only, never a rescan.
    function applyFromCache(editor: vscode.TextEditor | undefined): void {
        if (!editor || editor.document.languageId !== 'asp') { return; }
        const match = findPairAt(getPairsCachedOnly(editor.document), editor.selection.active);
        editor.setDecorations(decoration, match ? [match.opener.range, match.closer.range] : []);
    }

    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function scheduleRescan(document: vscode.TextDocument): void {
        if (document.languageId !== 'asp') { return; }
        const key = document.uri.toString();
        const existing = debounceTimers.get(key);
        if (existing) { clearTimeout(existing); }
        debounceTimers.set(key, setTimeout(() => {
            debounceTimers.delete(key);
            getPairsFresh(document); // warms the cache for the current version
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === document) { applyFromCache(editor); }
        }, 200));
    }

    context.subscriptions.push(
        decoration,
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor || editor.document.languageId !== 'asp') { return; }
            getPairsFresh(editor.document); // a tab switch is rare enough to scan synchronously
            applyFromCache(editor);
        }),
        vscode.window.onDidChangeTextEditorSelection(e => applyFromCache(e.textEditor)),
        vscode.workspace.onDidChangeTextDocument(e => scheduleRescan(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            _pairCache.delete(key);
            const timer = debounceTimers.get(key);
            if (timer) { clearTimeout(timer); debounceTimers.delete(key); }
        }),
    );

    context.subscriptions.push({
        dispose: () => {
            for (const timer of debounceTimers.values()) { clearTimeout(timer); }
            debounceTimers.clear();
        },
    });

    // Run immediately on whatever's already open, same as
    // registerAspStructureDiagnostics does for its own initial scan.
    if (vscode.window.activeTextEditor?.document.languageId === 'asp') {
        getPairsFresh(vscode.window.activeTextEditor.document);
        applyFromCache(vscode.window.activeTextEditor);
    }
}
