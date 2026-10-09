import * as vscode from 'vscode';
import { CHECK_DELAY, DocumentDebouncer } from '../platform/diagnostics';
import { analysedPage } from './vbscriptWorkspace';

/** A block's opener and the closer it was matched with, as they read in the editor. */
interface BlockPair {
    opener: vscode.Range;
    closer: vscode.Range;
}

// ─────────────────────────────────────────────────────────────────────────────
// aspBlockMatchProvider.ts
//
// VBScript has no braces, so its block keywords never get the highlight VS Code
// paints over a matching `{ }` pair. This gives them the same treatment: put
// the caret on `If` (or `Do`, `Sub`, `Select Case`, ...) and its `End If` lights
// up the way a `{` lights up its `}`.
//
// The pairing comes from the same scan that reports MISmatches (the structure
// warnings), read on the VBScript worker thread, so the highlight and the
// warnings can never disagree about how a file's blocks nest.
// ─────────────────────────────────────────────────────────────────────────────

// Cached by document version. A rescan reads the whole file, so it must never
// be asked for on every keystroke — onDidChangeTextEditorSelection fires
// once per cursor move, and a `type` command moves the cursor AND bumps the
// version in the same tick, so naively rescanning there added a synchronous
// full-document scan to every character typed anywhere in an .asp file. That
// was enough to starve other listeners on the same event loop turn (a real,
// observed regression in this extension's own auto-close-tag handler under
// load) for a highlight nobody was even looking at yet. The 200ms debounce
// below mirrors highlight.ts's own region-tint rescan for the same reason.
interface PairCache { version: number; pairs: BlockPair[]; }
const _pairCache = new Map<string, PairCache>();

/** Brings the cache up to the document's current version. Only for LOW-frequency call sites (a tab switch, the debounced rescan) — never for a per-keystroke event. */
async function refreshPairs(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    if (_pairCache.get(key)?.version === document.version) { return; }

    const page = await analysedPage(document);
    if (!page || document.isClosed || document.version !== page.version) { return; }
    const range = (k: { start: number; end: number }) => new vscode.Range(document.positionAt(k.start), document.positionAt(k.end));
    _pairCache.set(key, {
        version: page.version,
        pairs:   page.blocks.pairs.map(p => ({ opener: range(p.opener), closer: range(p.closer) })),
    });
}

/** Cheap: whatever's already cached, or nothing while a debounced rescan is still pending. Safe to call on every selection change. */
function getPairsCachedOnly(document: vscode.TextDocument): BlockPair[] {
    const cached = _pairCache.get(document.uri.toString());
    return cached && cached.version === document.version ? cached.pairs : [];
}

/** The pair whose opener or closer range contains `position`, if any. */
function findPairAt(pairs: BlockPair[], position: vscode.Position): BlockPair | undefined {
    return pairs.find(p => p.opener.contains(position) || p.closer.contains(position));
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
        editor.setDecorations(decoration, match ? [match.opener, match.closer] : []);
    }

    const rescans = new DocumentDebouncer(CHECK_DELAY.highlight, document => {
        void refreshPairs(document).then(() => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === document) { applyFromCache(editor); }
        });
    });

    context.subscriptions.push(
        decoration,
        rescans,
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor || editor.document.languageId !== 'asp') { return; }
            void refreshPairs(editor.document).then(() => applyFromCache(vscode.window.activeTextEditor));
        }),
        vscode.window.onDidChangeTextEditorSelection(e => applyFromCache(e.textEditor)),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'asp') { rescans.schedule(e.document); }
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            _pairCache.delete(doc.uri.toString());
            rescans.cancel(doc);
        }),
    );

    // Run immediately on whatever's already open, same as
    // registerAspStructureDiagnostics does for its own initial scan.
    if (vscode.window.activeTextEditor?.document.languageId === 'asp') {
        void refreshPairs(vscode.window.activeTextEditor.document).then(() => applyFromCache(vscode.window.activeTextEditor));
    }
}
