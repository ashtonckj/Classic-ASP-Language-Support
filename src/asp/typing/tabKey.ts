/**
 * tabKey.ts  (asp/typing/)
 *
 * Tab in an ASP page: Emmet expansion in markup and CSS, and an indent step
 * elsewhere.
 */

import * as vscode from 'vscode';
import { otherSetting } from '../../platform/settings';
import { log } from '../../platform/log';
import { isInlineTag, isSelfClosingTag } from '../../constants/htmlTags';
import { ASP_OBJECT_NAMES } from '../../constants/aspKeywords';
import type { Zone } from '../../core/zoneUtils';
import { zonesFor } from '../../platform/documentState';
import { findEnclosingHtmlChildIndent, isBlockOpener } from './vbIndent';
import { getIndentUnit } from './editing';

// ── Tab key handler ────────────────────────────────────────────────────────

/**
 * Tokens that are unmistakably an Emmet abbreviation rather than prose.
 *
 * `>` `+` `^` `*` are Emmet's structural operators (child, sibling, climb,
 * multiply) and do not otherwise appear inside a word; the second form is the
 * class/id shorthand, anchored so the WHOLE token has to look like one.
 *
 * This is what makes expanding on Tab safe without the global setting. VS Code
 * turns `emmet.triggerExpansionOnTab` off by default because with it on, any
 * word plus Tab expands — typing `Total` in body text and reaching for Tab gives
 * `<Total></Total>`, and an ASP page is mostly body text. Requiring one of these
 * markers keeps `ul>li*3` and `div.row` working while leaving a plain word alone.
 */
const ABBREVIATION_OPERATORS = /[>+^*]/;
const ABBREVIATION_SHORTHAND = /^(?:[A-Za-z][\w-]*)?(?:[.#][\w-]+)+$/;

/** The run of non-whitespace immediately before the caret. */
function tokenBefore(lineText: string, character: number): string {
    const upToCaret = lineText.slice(0, character);
    return upToCaret.slice(upToCaret.search(/\S*$/));
}

/**
 * True when the text before the caret is worth handing to Emmet even though the
 * user has not turned on expansion for every word.
 *
 * This only decides whether a word in an HTML or CSS zone is worth offering.
 * What keeps VBScript safe is the zone, checked by the caller: `tag.class` is
 * also the shape of every member expression in the language — Response.CharSet,
 * Request.Form, Server.MapPath — and no amount of inspecting the token tells the
 * two apart.
 */
export function looksLikeAbbreviation(token: string): boolean {
    if (!token || token.includes('<')) { return false; }

    // A member of one of ASP's intrinsic objects is code, wherever it appears.
    // The zone check above is the real defence, but it reads a page the way the
    // engine does, and the engine ends a block at the first `%>` — even one
    // inside a string. Everything after such a block is an HTML zone by the
    // engine's own rule, so `Response.CharSet` on the next line would otherwise
    // be offered to Emmet with nothing left to stop it.
    const root = token.split(/[.#>+^*]/, 1)[0];
    if (ASP_OBJECT_NAMES.has(root.toLowerCase())) { return false; }

    return ABBREVIATION_OPERATORS.test(token) || ABBREVIATION_SHORTHAND.test(token);
}

/**
 * Emmet's Tab expansion, falling back to a plain Tab when nothing expanded.
 *
 * Tab is bound to `asp.insertTab` for this language, so everything the Tab key
 * would otherwise do has to happen here — and one of those things is Emmet
 * turning `ul>li*3` into a real list, which is how HTML gets written by hand.
 * Going straight to the native `tab` command swallowed it, because that command
 * knows nothing about abbreviations.
 *
 * Emmet is offered the caret in two cases:
 *
 *   * the user turned on `emmet.triggerExpansionOnTab`, in which case they have
 *     asked for VS Code's own behaviour and every word is a candidate;
 *   * otherwise, only when the text before the caret carries an unmistakable
 *     abbreviation marker — see ABBREVIATION_OPERATORS. That is a deliberate
 *     divergence from a .html file, where the same keystroke does nothing: an
 *     abbreviation is the whole reason to reach for Tab there, and requiring a
 *     hidden setting to get it is worse than the small surprise of `a>b`
 *     expanding.
 *
 * Only the HTML and CSS zones are offered at all. Inside `<% %>` an abbreviation
 * like `ul>li*3` is a comparison between two undeclared variables, and inside
 * `<script>` it is JavaScript; expanding either would replace working code with
 * markup.
 */
async function expandAbbreviationOrTab(
    editor:   vscode.TextEditor,
    position: vscode.Position,
): Promise<void> {
    const triggerOnTab = otherSetting<boolean>('emmet', 'triggerExpansionOnTab', editor.document.uri) ?? false;

    const lineText = editor.document.lineAt(position.line).text;
    const worthTrying = triggerOnTab
        || looksLikeAbbreviation(tokenBefore(lineText, position.character));

    if (worthTrying) {
        const zone = zonesFor(editor.document).zoneAt(editor.document.offsetAt(position));
        if (zone === 'html' || zone === 'css') {
            const outcome = await tryEmmetExpansion(editor, zone);
            if (outcome === 'expanded') { return; }

            // Emmet's own failure path ends in `executeCommand('tab')`, but only
            // when emmet.triggerExpansionOnTab is on. So when it is on and Emmet
            // was asked, the Tab has already been dealt with and inserting
            // another indents twice.
            //
            // Asking the document whether it changed does not settle this: the
            // `tab` command can resolve before its edit is applied, so the check
            // sometimes sees the old version and sometimes the new one. That
            // showed up as an intermittent double indent. The setting is the
            // reliable signal, because it is what Emmet itself branches on.
            if (outcome === 'ran' && triggerOnTab) { return; }
        }
    }

    await vscode.commands.executeCommand('tab');
}

/**
 * Emmet's own commands, in the order worth trying.
 *
 * `emmet.expandAbbreviation` is the one the Emmet extension registers, and the
 * only one that takes arguments — it accepts `{ language }` and falls back to
 * the document's own language id only when none is given. Since `asp` is
 * deliberately absent from emmet.includeLanguages, naming the syntax is what
 * makes expansion work at all, so it is tried first.
 *
 * `editor.emmet.action.expandAbbreviation` is an editor action registered by
 * VS Code itself rather than by the Emmet extension. It ignores arguments and
 * reads the document's language, so for an .asp file it does nothing; it stays
 * as a fallback for a build where the first command is missing.
 */
const EMMET_EXPAND_COMMANDS = [
    'emmet.expandAbbreviation',
    'editor.emmet.action.expandAbbreviation',
];

/**
 * Asks Emmet to expand whatever is under the caret. Returns true if it did.
 *
 * Emmet is a built-in extension, which means it can be disabled — and when it
 * is, invoking the command rejects with "command 'emmet.expandAbbreviation' not
 * found". Letting that propagate out of the Tab handler did two bad things at
 * once: it put an error notification in front of the user, and it swallowed the
 * keystroke, so Tab stopped inserting anything at all. A failure here has to
 * degrade to an ordinary Tab silently.
 *
 * Whether the document changed is the only signal that Emmet acted, because it
 * reports nothing when the text under the caret is not an abbreviation.
 */
type EmmetOutcome =
    | 'expanded'      // Emmet rewrote the abbreviation
    | 'ran'           // Emmet was asked and declined; it may have run `tab` itself
    | 'unavailable';  // no expand command could be invoked at all

/**
 * How long to keep waiting for Emmet's edit after its command has resolved.
 *
 * Reading `document.version` the moment the command returns does not work:
 * Emmet expands through `editor.insertSnippet`, and that applies the edit in the
 * editor before the extension host's copy of the document has caught up. Measured
 * in a real Extension Host, an expansion that plainly succeeded still reported
 * version 1 → 1 on return and only reached version 2 afterwards — so the check
 * said "no expansion" EVERY time, and the caller's fallback dropped an indent
 * into the snippet's first tabstop: `ul>li*3` + Tab gave `<li>    </li>`.
 *
 * The change event is the signal that does arrive, and only the one IPC hop
 * behind, so the wait is short and is cut off by the first event. It is also only
 * ever paid when Emmet DECLINED — an expansion resolves as soon as its edit lands.
 */
const EMMET_EDIT_GRACE_MS = 300;

/** Resolves true if `document` changes within `EMMET_EDIT_GRACE_MS`. */
function waitForEdit(document: vscode.TextDocument): { settled: () => Promise<boolean>, dispose: () => void } {
    let changed = false;
    let notify: (() => void) | undefined;
    const subscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== document || event.contentChanges.length === 0) { return; }
        changed = true;
        notify?.();
    });

    return {
        dispose: () => subscription.dispose(),
        settled: () => new Promise<boolean>(resolve => {
            const finish = (result: boolean) => {
                clearTimeout(timer);
                subscription.dispose();
                resolve(result);
            };
            if (changed) { finish(true); return; }
            notify = () => finish(true);
            const timer = setTimeout(() => finish(false), EMMET_EDIT_GRACE_MS);
        }),
    };
}

async function tryEmmetExpansion(editor: vscode.TextEditor, zone: Zone): Promise<EmmetOutcome> {
    // The syntax is named explicitly because it has to be: `asp` is deliberately
    // absent from emmet.includeLanguages — that mapping is per language and
    // would offer abbreviations inside <% %> too, which is why the suggest-widget
    // route is served by this extension's own provider instead. Naming the
    // syntax per call is also what gets a caret inside <style> treated as CSS.
    const language = zone === 'css' ? 'css' : 'html';

    for (const command of EMMET_EXPAND_COMMANDS) {
        const edit = waitForEdit(editor.document);
        try {
            await vscode.commands.executeCommand(command, { language });
        } catch {
            edit.dispose();
            continue;   // not registered in this build, or Emmet is disabled
        }

        // The first command that RAN settles it — trying the next after a no-op
        // would ask Emmet to act twice on one keystroke.
        return await edit.settled() ? 'expanded' : 'ran';
    }

    warnEmmetUnavailableOnce();
    return 'unavailable';
}

let warnedAboutEmmet = false;

/**
 * Says once why an abbreviation did nothing.
 *
 * Swallowing the failure is right — a dialog every time someone presses Tab
 * would be far worse than a Tab that just indents — but it leaves no trace at
 * all, and "Emmet is turned off" is not something anyone would guess from a
 * silent no-op. The log is where that belongs: no interruption, and still
 * findable in the "Classic ASP" output channel when someone goes looking.
 */
function warnEmmetUnavailableOnce(): void {
    if (warnedAboutEmmet) { return; }
    warnedAboutEmmet = true;
    log.warn(
        'Emmet did not respond, so Tab inserted an indent instead of '
        + 'expanding an abbreviation. Emmet is a built-in extension and may be '
        + 'disabled — check the Extensions view with the filter "@builtin emmet".',
    );
}

export function registerTabKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertTab', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('tab');
        }

        // Multi-cursor: the smart single-cursor indent below can't serve N cursors,
        // so defer to the native tab, which indents at every cursor.
        if (editor.selections.length > 1) {
            return vscode.commands.executeCommand('tab');
        }

        const position  = editor.selection.active;
        const lineText  = editor.document.lineAt(position.line).text;

        // Only apply smart indent on a completely blank line. Anything else is a
        // plain Tab — or an Emmet abbreviation waiting to be expanded.
        if (lineText.trim() !== '') {
            return expandAbbreviationOrTab(editor, position);
        }

        // ...and only when the cursor is at the END of that blank line. If there is
        // whitespace after the cursor, behave like a normal Tab — insert an indent
        // at the cursor and preserve what follows — instead of snapping the whole
        // line (which discarded the trailing spaces and mis-placed the cursor).
        if (position.character !== lineText.length) {
            return vscode.commands.executeCommand('tab');
        }

        const indentUnit = getIndentUnit(editor);

        // Find nearest non-empty line above
        let baseIndent   = '';
        let prevLineText = '';
        for (let i = position.line - 1; i >= 0; i--) {
            const text = editor.document.lineAt(i).text;
            if (text.trim().length > 0) {
                baseIndent   = text.match(/^(\s*)/)?.[1] ?? '';
                prevLineText = text.trim();
                break;
            }
        }

        const currentIndent = lineText.match(/^(\s*)/)?.[1] ?? '';
        // Only reached on blank lines where smart indent actually runs, so the
        // zones are never read for an ordinary Tab.
        const inAsp = zonesFor(editor.document).zoneAt(editor.document.offsetAt(position)) === 'asp';

        let targetIndent: string;
        if (prevLineText === '%>') {
            // After a closing %> fragment delimiter, we're back in HTML context.
            // Use the enclosing HTML opener's child indent — same logic as Enter after %>.
            targetIndent = findEnclosingHtmlChildIndent(editor.document, position.line, indentUnit)
                           ?? baseIndent;
        } else if (prevLineText.startsWith('<%')) {
            // After <% — VBScript code is at the same level as <%, no extra indent
            targetIndent = baseIndent;
        } else if (inAsp && isBlockOpener(prevLineText)) {
            targetIndent = baseIndent + indentUnit;
        } else if (inAsp) {
            targetIndent = baseIndent;
        } else {
            // Plain HTML / <script> / <style>:
            // Add one extra level when the previous line opens a block.
            // A JS/CSS block opener ends with '{'.
            // An HTML block opener ends with '>' and is a non-self-closing, non-inline tag.
            const htmlOpenerMatch = prevLineText.match(/^<(\w+)(\s[^>]*)?>$/);
            const isHtmlOpener = htmlOpenerMatch
                && !isInlineTag(htmlOpenerMatch[1])
                && !isSelfClosingTag(htmlOpenerMatch[1]);
            const opensBlock = prevLineText.endsWith('{') || !!isHtmlOpener;
            targetIndent = opensBlock ? baseIndent + indentUnit : baseIndent;
        }

        // Snap up to correct level if below it, otherwise freely +1
        const newIndent = currentIndent.length < targetIndent.length
            ? targetIndent
            : currentIndent + indentUnit;

        // Replace the line's ENTIRE leading whitespace (the line is blank here),
        // not just col-0 → cursor. Using `position` as the range end left the
        // existing spaces in place when the cursor sat before them (e.g. at col 0),
        // producing doubled/misplaced indentation.
        return editor.edit(eb => {
            eb.replace(
                new vscode.Range(new vscode.Position(position.line, 0), new vscode.Position(position.line, lineText.length)),
                newIndent,
            );
        }).then(() => {
            const p = new vscode.Position(position.line, newIndent.length);
            editor.selection = new vscode.Selection(p, p);
        });
    });

    context.subscriptions.push(disposable);
}
