/**
 * quoteGuard.ts  (asp/typing/)
 *
 * A single quote in VBScript starts a comment, so it is not paired.
 */

import * as vscode from 'vscode';
import { zonesFor } from '../../platform/documentState';

// ── Single quotes in VBScript ──────────────────────────────────────────────
//
// VS Code auto-closes quotes from the DOCUMENT's language configuration, not
// from the embedded language under the caret — measured: a `'` typed in the
// markup, a <style> or a <script> of an .asp page follows asp's rules. So
// language-configuration.json closes `'` with the very pair html uses, and those
// three zones behave exactly as a .html file does, typing over the quote and
// deleting the pair included, under the user's own editor.autoClosing* settings.
//
// VBScript is the exception, because there `'` starts a comment. The closing
// quote VS Code has just added is removed again here. Removing a character
// AFTER the caret leaves the caret where it is, and the edit is refused if the
// document has moved on, in which case the next change retries it.
//
// This replaces an override of the global `type` command, which doubled every
// apostrophe in page text (`don't` came out as `don't'`), ignored the user's
// settings, sent every keystroke in every editor through the extension host,
// and could not activate beside another extension that owns `type` (Vim).

/** A position in a document, as line and character. */
interface QuotePosition { line: number; character: number; }

/**
 * Where each `''` VS Code auto-inserted now sits, from change ranges given in
 * PRE-edit coordinates: every earlier insertion on the same line pushes a later
 * one two columns right.
 */
export function insertedPairPositions(starts: readonly QuotePosition[]): QuotePosition[] {
    const ascending = [...starts].sort((a, b) => a.line - b.line || a.character - b.character);
    const earlierOnLine = new Map<number, number>();
    return ascending.map(({ line, character }) => {
        const earlier = earlierOnLine.get(line) ?? 0;
        earlierOnLine.set(line, earlier + 1);
        return { line, character: character + 2 * earlier };
    });
}

/**
 * Moves each position with an edit, or drops it when the edit removes that
 * character or spans lines. Change ranges are in PRE-edit coordinates.
 */
export function shiftQuotePositions(
    positions: readonly QuotePosition[],
    changes: readonly { range: vscode.Range; text: string }[],
): QuotePosition[] {
    const kept: QuotePosition[] = [];
    for (const position of positions) {
        let character = position.character;
        let gone = false;
        for (const { range, text } of changes) {
            if (range.start.line !== range.end.line || text.includes('\n')) {
                if (range.start.line <= position.line) { gone = true; }
                continue;
            }
            if (range.start.line !== position.line) { continue; }
            if (range.start.character <= position.character && position.character < range.end.character) { gone = true; }
            else if (range.end.character <= position.character) {
                character += text.length - (range.end.character - range.start.character);
            }
        }
        if (!gone) { kept.push({ line: position.line, character }); }
    }
    return kept;
}

export function registerVbScriptQuoteGuard(context: vscode.ExtensionContext): void {
    // `''` just inserted in VBScript, waiting for the caret to show whether it
    // was an auto-close (caret between the quotes) or a paste (caret after).
    const candidates = new Map<string, QuotePosition[]>();
    // Closing quotes known to be auto-inserted in VBScript, not yet removed.
    const strays = new Map<string, QuotePosition[]>();

    const set = (map: Map<string, QuotePosition[]>, key: string, list: QuotePosition[]) => {
        if (list.length > 0) { map.set(key, list); } else { map.delete(key); }
    };

    const removeStrays = (document: vscode.TextDocument): void => {
        const key = document.uri.toString();
        const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
        const pending = (strays.get(key) ?? []).filter(q =>
            q.line < document.lineCount && document.lineAt(q.line).text[q.character] === "'");
        set(strays, key, pending);
        if (!editor || pending.length === 0) { return; }

        void editor.edit(eb => {
            for (const q of pending) {
                eb.delete(new vscode.Range(q.line, q.character, q.line, q.character + 1));
            }
        }, { undoStopBefore: false, undoStopAfter: false });
    };

    /**
     * Settles the candidates the carets tell apart: a caret between the two
     * quotes means VS Code auto-closed, a caret after both means they were
     * pasted, and those are left alone. The change event can arrive before the
     * editor's selection has caught up, so until the selection event itself
     * (`final`) a candidate neither caret explains is kept waiting.
     */
    const decide = (document: vscode.TextDocument, selections: readonly vscode.Selection[], final: boolean): void => {
        const key = document.uri.toString();
        const waiting = candidates.get(key);
        if (!waiting) { return; }

        const caretAt = (line: number, character: number) =>
            selections.some(s => s.isEmpty && s.active.line === line && s.active.character === character);

        const stillWaiting: QuotePosition[] = [];
        const confirmed:    QuotePosition[] = [];
        for (const q of waiting) {
            if (caretAt(q.line, q.character + 1))         { confirmed.push({ line: q.line, character: q.character + 1 }); }
            else if (!final && !caretAt(q.line, q.character + 2)) { stillWaiting.push(q); }
        }
        set(candidates, key, stillWaiting);
        if (confirmed.length > 0) {
            set(strays, key, [...(strays.get(key) ?? []), ...confirmed]);
            removeStrays(document);
        }
    };

    const onChange = vscode.workspace.onDidChangeTextDocument(event => {
        const document = event.document;
        if (document.languageId !== 'asp' || event.contentChanges.length === 0) { return; }
        const key = document.uri.toString();

        set(strays, key, shiftQuotePositions(strays.get(key) ?? [], event.contentChanges));
        // A candidate that another edit reaches first is no longer decidable.
        candidates.delete(key);

        if (event.reason !== vscode.TextDocumentChangeReason.Undo
            && event.reason !== vscode.TextDocumentChangeReason.Redo) {
            // An auto-closed quote arrives as one edit inserting both quotes.
            const pairs = event.contentChanges.filter(c => c.text === "''" && c.rangeLength === 0);
            if (pairs.length > 0) {
                const zones = zonesFor(document);
                const inVbScript = insertedPairPositions(pairs.map(c => c.range.start)).filter(p =>
                    zones.zoneAt(document.offsetAt(new vscode.Position(p.line, p.character))) === 'asp');
                set(candidates, key, inVbScript);
                const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
                if (editor) { decide(document, editor.selections, false); }
            }
        }

        if (strays.has(key)) { removeStrays(document); }
    });

    const onSelection = vscode.window.onDidChangeTextEditorSelection(event => {
        if (candidates.has(event.textEditor.document.uri.toString())) {
            decide(event.textEditor.document, event.selections, true);
        }
    });

    const onClose = vscode.workspace.onDidCloseTextDocument(document => {
        candidates.delete(document.uri.toString());
        strays.delete(document.uri.toString());
    });

    context.subscriptions.push(onChange, onSelection, onClose);
}