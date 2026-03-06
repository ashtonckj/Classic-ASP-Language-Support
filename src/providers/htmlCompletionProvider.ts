import * as vscode from 'vscode';
import { HTML_TAGS, isSelfClosingTag } from '../constants/htmlTags';
import { getAttributesForTag } from '../constants/htmlGlobals';
import {
    getContext,
    ContextType,
    getCurrentTagName,
    isInsideTagForAttributes,
    isInsideAspBlock
} from '../utils/documentHelper';

// ── VBScript block keyword constants ───────────────────────────────────────

// Pure openers: start a block, next line should be +1 indent
const VBSCRIPT_BLOCK_OPENERS = /^(If\b.*Then|For\b|For\s+Each\b|Do\b|Do\s+While\b|Do\s+Until\b|While\b|Sub\b|Function\b|With\b|Select\s+Case\b|Class\b)/i;

// Pure closers: end a block, snap back to opener indent level
const VBSCRIPT_BLOCK_CLOSERS = /^(End\s+If\b|End\s+Sub\b|End\s+Function\b|End\s+With\b|End\s+Select\b|End\s+Class\b|Next\b|Loop\b|Wend\b)/i;

// Mid-block keywords: close the block above AND open a new block below.
// On Enter they snap to their opener's indent level (+snapOffset), then give +1 on the next line.
// ElseIf/Else are peers of If  → snapOffset 0 (same indent as If)
// Case is subordinate to Select Case → snapOffset 1 (one level inside Select Case)
const VBSCRIPT_MID_BLOCK = /^(ElseIf\b|Else\b|Case\b)/i;

// Exact-match regex for auto-snap (onDidChangeTextDocument)
const VBSCRIPT_EXACT_CLOSER =
    /^(End\s+If|End\s+Sub|End\s+Function|End\s+With|End\s+Select|End\s+Class|Next|Loop|Wend|ElseIf(?:\s+.*Then)?|Else|Case(?:\s+Else)?(?:\s+\S.*)?)$/i;

// Maps each closer/mid-block to its matching opener.
// snapOffset: how many extra indent levels to add on top of the opener's indent when snapping.
//   0 = align flush with opener (ElseIf/Else peers with If)
//   1 = one level inside opener (Case sits inside Select Case)
// family: links mid-block siblings so pure closers (End If) skip past them transparently.
const CLOSER_TO_OPENER: { closer: RegExp; opener: RegExp; isMidBlock?: boolean; snapOffset?: number; family?: string }[] = [
    { closer: /^End\s+If\b/i,       opener: /^If\b.*Then$/i,                    family: 'if' },
    { closer: /^End\s+Sub\b/i,      opener: /^Sub\b/i },
    { closer: /^End\s+Function\b/i, opener: /^Function\b/i },
    { closer: /^End\s+With\b/i,     opener: /^With\b/i },
    { closer: /^End\s+Select\b/i,   opener: /^Select\s+Case\b/i,                 family: 'select' },
    { closer: /^End\s+Class\b/i,    opener: /^Class\b/i },
    { closer: /^Next\b/i,           opener: /^For\b|^For\s+Each\b/i },
    { closer: /^Loop\b/i,           opener: /^Do\b|^Do\s+While\b|^Do\s+Until\b/i },
    { closer: /^Wend\b/i,           opener: /^While\b/i },
    // Mid-block If family — peers of If, snap to its indent (snapOffset 0)
    { closer: /^ElseIf\b/i,         opener: /^If\b.*Then$|^ElseIf\b.*Then$/i,   isMidBlock: true, snapOffset: 0, family: 'if' },
    { closer: /^Else\b/i,           opener: /^If\b.*Then$|^ElseIf\b.*Then$/i,   isMidBlock: true, snapOffset: 0, family: 'if' },
    // Mid-block Select family — Case sits one level inside Select Case (snapOffset 1)
    { closer: /^Case\b/i,           opener: /^Select\s+Case\b/i,                 isMidBlock: true, snapOffset: 1, family: 'select' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Faster isInsideAspBlock that avoids fetching the entire document string.
 * Reads only the text up to the position plus a small window ahead.
 */
function isInAspBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
    const before = document.getText(
        new vscode.Range(new vscode.Position(0, 0), position)
    );
    // Search the entire remainder of the document so that long ASP blocks
    // (where %>  is more than a fixed char-window away) are detected correctly.
    const after = document.getText(
        new vscode.Range(position, document.lineAt(document.lineCount - 1).range.end)
    );

    const lastOpen  = before.lastIndexOf('<%');
    const lastClose = before.lastIndexOf('%>');
    const nextClose = after.indexOf('%>');

    return lastOpen > lastClose && nextClose !== -1;
}

/**
 * Returns the indent unit string from editor options.
 * Shared by Enter and Tab handlers to avoid duplicating those 3 lines.
 */
function getIndentUnit(editor: vscode.TextEditor): string {
    const tabSize  = editor.options.tabSize as number || 4;
    const useSpaces = editor.options.insertSpaces !== false;
    return useSpaces ? ' '.repeat(tabSize) : '\t';
}

/**
 * Scans upward to find the indent of the opener matching a given closer keyword.
 *
 * Handles three kinds of keywords:
 *   Pure closers  (End If, Next, …)   → scan up until matching opener found
 *   Mid-block     (ElseIf, Else, Case) → when they ARE the keyword being resolved,
 *                                         they snap to the same indent as their opener.
 *                                         When a pure closer (End If) scans past them
 *                                         they are transparent — depth is unchanged.
 *   Foreign blocks                     → tracked independently so nesting of a
 *                                         different block type doesn't confuse the scan.
 */
function findMatchingOpenerIndent(
    document: vscode.TextDocument,
    closerLineIndex: number,
    closerText: string,
    indentUnit: string = '    '
): string | null {
    const targetIdx = CLOSER_TO_OPENER.findIndex(p => p.closer.test(closerText));
    if (targetIdx === -1) { return null; }

    const targetEntry   = CLOSER_TO_OPENER[targetIdx];
    const targetIsMid   = !!targetEntry.isMidBlock;
    const snapOffset    = targetEntry.snapOffset ?? 0;

    // All mid-block entries in the same family (ElseIf + Else, both family 'if').
    // When a pure closer (End If) scans past them they are transparent — depth unchanged.
    // When a mid-block is resolving itself, hitting a same-family sibling is a valid boundary.
    const familySiblingIndices = targetEntry.family
        ? CLOSER_TO_OPENER
            .map((p, i) => ({ p, i }))
            .filter(({ p, i }) => i !== targetIdx && p.isMidBlock && p.family === targetEntry.family)
            .map(({ i }) => i)
        : [];

    let targetDepth = 1;
    // Track unmatched pure closers of foreign block types so we don't miscount
    // openers that belong to a nested foreign block.
    const foreignDepth: number[] = CLOSER_TO_OPENER.map(() => 0);

    for (let i = closerLineIndex - 1; i >= 0; i--) {
        const text = document.lineAt(i).text.trim();
        if (!text) { continue; }

        // ── Closer-side check ──────────────────────────────────────────────
        const closerIdx = CLOSER_TO_OPENER.findIndex(p => p.closer.test(text));
        if (closerIdx !== -1) {
            if (closerIdx === targetIdx) {
                if (!foreignDepth.some(d => d > 0)) {
                    if (targetIsMid && targetDepth === 1) {
                        // Another same-type mid-block at depth 1 is our boundary.
                        // It's already at the correct indent — return it as-is, no snapOffset.
                        const m = document.lineAt(i).text.match(/^(\s*)/);
                        return m ? m[1] : '';
                    }
                    targetDepth++;
                }
            } else if (familySiblingIndices.includes(closerIdx)) {
                if (!foreignDepth.some(d => d > 0)) {
                    if (targetIsMid && targetDepth === 1) {
                        // Hit a family sibling (e.g. ElseIf hits Else).
                        // Sibling is already at the correct indent — return as-is, no snapOffset.
                        const m = document.lineAt(i).text.match(/^(\s*)/);
                        return m ? m[1] : '';
                    }
                    // Pure closer (End If) hits ElseIf/Else/Case → transparent, skip
                }
            } else {
                foreignDepth[closerIdx]++;
            }
            continue;
        }

        // ── Opener-side check ──────────────────────────────────────────────
        // Match directly against our target's own opener pattern — NOT via findIndex,
        // because findIndex returns the wrong entry when multiple entries share an opener
        // (e.g. "If condition Then" matches both End-If's opener AND ElseIf's opener).
        if (targetEntry.opener.test(text)) {
            if (!foreignDepth.some(d => d > 0)) {
                targetDepth--;
                if (targetDepth === 0) {
                    const m = document.lineAt(i).text.match(/^(\s*)/);
                    const base = m ? m[1] : '';
                    return base + indentUnit.repeat(snapOffset);
                }
            }
            continue;
        }

        // Check if this line is a pure opener for a foreign block type so we can
        // balance its corresponding closer we may have counted above.
        for (let j = 0; j < CLOSER_TO_OPENER.length; j++) {
            if (j === targetIdx || familySiblingIndices.includes(j)) { continue; }
            if (CLOSER_TO_OPENER[j].opener.test(text)) {
                if (foreignDepth[j] > 0) { foreignDepth[j]--; }
                break;
            }
        }
    }

    return null;
}

/**
 * Scans upward from closerLineIndex to find the indent of the matching <%
 * for a standalone %> line. Tracks nesting so inner <%...%> pairs are skipped.
 */
function findAspOpenerIndent(document: vscode.TextDocument, closerLineIndex: number): string | null {
    let depth = 1;
    for (let i = closerLineIndex - 1; i >= 0; i--) {
        const text = document.lineAt(i).text.trim();
        if (!text) { continue; }
        // A line that closes an ASP block (without also opening one) increases depth
        if (/^%>$/.test(text) || (/^(?!<%).*%>$/.test(text))) {
            depth++;
        } else if (/^<%/.test(text)) {
            depth--;
            if (depth === 0) {
                const m = document.lineAt(i).text.match(/^(\s*)/);
                return m ? m[1] : '';
            }
        }
    }
    return null;
}

/**
 * Scans upward from startLine to find the indent of the nearest unclosed
 * HTML block-level opener tag (skipping self-closing and inline tags).
 * Returns openerIndent + indentUnit — the correct child indent level.
 * Returns null when at document root (no enclosing HTML block tag found).
 *
 * Properly tracks closing tag depth so </ul> cancels its own <ul>, and
 * skips <%...%> fragments entirely so VBScript lines don't confuse the scan.
 */
function findEnclosingHtmlChildIndent(
    document: vscode.TextDocument,
    startLine: number,
    indentUnit: string
): string | null {
    const INLINE_TAGS = /^(a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr|img|input|link|meta|hr|area|base|col|embed|param|source|track)$/i;

    let aspDepth  = 0;
    // closedTags[tag] counts how many closing tags of that name we've passed
    // without yet seeing their opener — those openers must be skipped.
    const closedTags: Record<string, number> = {};

    for (let i = startLine - 1; i >= 0; i--) {
        const raw  = document.lineAt(i).text;
        const text = raw.trim();
        if (!text) { continue; }

        // Skip ASP fragment content (scan backwards: %> raises depth, <% lowers it)
        if (/^%>/.test(text) || (text.endsWith('%>') && !text.startsWith('<%'))) {
            aspDepth++;
            continue;
        }
        if (/^<%/.test(text)) {
            if (aspDepth > 0) { aspDepth--; }
            continue;
        }
        if (aspDepth > 0) { continue; }

        // Closing HTML tag — record it so its matching opener is skipped
        const closingMatch = text.match(/^<\/(\w+)/i);
        if (closingMatch) {
            const tag = closingMatch[1].toLowerCase();
            closedTags[tag] = (closedTags[tag] ?? 0) + 1;
            continue;
        }

        // Opening HTML tag — check whether it is the enclosing parent
        // The regex requires the tag is NOT self-closed on the same line (e.g. <div></div>)
        const openingMatch = text.match(/^<(\w+)(\s[^>]*)?>(?!.*<\/\1\s*>)/i);
        if (openingMatch) {
            const tag = openingMatch[1].toLowerCase();
            if (INLINE_TAGS.test(tag) || isSelfClosingTag(tag)) { continue; }
            // If we've already seen a closer for this tag, it cancels this opener
            if (closedTags[tag] && closedTags[tag] > 0) {
                closedTags[tag]--;
                continue;
            }
            // This is an unmatched opener — it's our enclosing parent
            const m = raw.match(/^(\s*)/);
            return (m ? m[1] : '') + indentUnit;
        }
    }
    return null;
}



// ── Cached completion items — built once, reused on every keystroke ────────

let _cachedTagCompletions: vscode.CompletionItem[] | null = null;
const _cachedAttrCompletions = new Map<string, vscode.CompletionItem[]>();

function getTagCompletions(): vscode.CompletionItem[] {
    if (_cachedTagCompletions) { return _cachedTagCompletions; }

    _cachedTagCompletions = HTML_TAGS.map(tag => {
        const item = new vscode.CompletionItem(tag.tag, vscode.CompletionItemKind.Property);
        item.detail = tag.description;
        item.documentation = new vscode.MarkdownString(`HTML <${tag.tag}> element\n\n${tag.description}`);
        item.insertText = isSelfClosingTag(tag.tag)
            ? new vscode.SnippetString(`${tag.tag} $0/>`)
            : new vscode.SnippetString(`${tag.tag}>\n\t$0\n</${tag.tag}>`);
        item.sortText = '2_' + tag.tag;
        return item;
    });

    return _cachedTagCompletions;
}

function getAttributeCompletions(tagName: string): vscode.CompletionItem[] {
    const key = tagName.toLowerCase();
    if (_cachedAttrCompletions.has(key)) { return _cachedAttrCompletions.get(key)!; }

    const items = getAttributesForTag(tagName).map(attr => {
        const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
        item.detail = attr.description;
        item.documentation = new vscode.MarkdownString(`**${attr.name}** attribute\n\n${attr.description}`);
        item.insertText = attr.name.endsWith('-')
            ? new vscode.SnippetString(`${attr.name}$1="$2"`)
            : new vscode.SnippetString(`${attr.name}="$0"`);
        item.sortText = '2_' + attr.name;
        return item;
    });

    _cachedAttrCompletions.set(key, items);
    return items;
}

// ── Completion provider ────────────────────────────────────────────────────

export class HtmlCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const config = vscode.workspace.getConfiguration('aspLanguageSupport');
        if (!config.get<boolean>('enableHTMLCompletion', true)) { return []; }
        if (getContext(document, position) !== ContextType.HTML) { return []; }

        const textBefore = document.lineAt(position.line).text.substring(0, position.character);

        if (context.triggerCharacter === '<') { return getTagCompletions(); }
        if (textBefore.match(/<(\w+)$/))      { return getTagCompletions(); }

        if (isInsideTagForAttributes(document, position)) {
            const tagName = getCurrentTagName(document, position);
            if (tagName) {
                const afterTagName = textBefore.match(/<\w+\s+(.*)$/);
                if (afterTagName && afterTagName[1].trim().length > 0) {
                    return getAttributeCompletions(tagName);
                }
                if (context.triggerCharacter === ' ') {
                    return getAttributeCompletions(tagName);
                }
            }
        }

        return [];
    }
}

// ── Line-continuation patterns that mean a trailing _ is NOT an identifier ──
// Each pattern matches the text BEFORE the _ on the line (trimmed).
// If any matches, the _ is a line continuation and suggestions must be hidden.
const LINE_CONTINUATION_BEFORE_PATTERNS: RegExp[] = [
    // Assignment:  something =  _
    /=\s*$/,
    // Concatenation operator:  & _   or  + _
    /[&+]\s*$/,
    // Comparison / logical operators:  <> _ , <= _ , >= _ , = _ , And _ , Or _ , Not _
    /(?:<=|>=|<>|<|>|=|And|Or|Not|Xor|Eqv|Imp)\s*$/i,
    // Arithmetic operators:  * _  / _  \ _  Mod _  ^ _  - _
    /(?:\*|\/|\\|Mod|\^|-)\s*$/i,
    // Open paren (argument list continues):  SomeFunc( _
    /\(\s*$/,
    // Comma (argument or array element continues):  arg1, _
    /,\s*$/,
    // After a closing paren/bracket (chained call):  ) _   or  ] _
    /[)\]]\s*$/,
    // Keyword that expects a value to follow:  Then _  Else _  Return _  Call _
    /(?:Then|Else|ElseIf|Return|Call|Set|Let|ReDim|Dim|Private|Public|Const)\s*$/i,
];

/**
 * Returns true when the trailing _ on the given line is a VBScript
 * line-continuation character rather than part of an identifier.
 *
 * Rules:
 *   1. The _ must be preceded by at least one whitespace character
 *      (a bare  _name  at the start of a word is always an identifier).
 *   2. The text before the _ (trimmed) must match at least one of the
 *      known line-continuation context patterns above.
 */
function isLineContinuation(lineTextUpToCursor: string): boolean {
    // Must have whitespace immediately before the trailing _
    if (!/\s_\s*$/.test(lineTextUpToCursor)) { return false; }

    const beforeUnderscore = lineTextUpToCursor.replace(/\s_\s*$/, '').trimEnd();

    // A line that is ONLY _ (or indented _) with nothing before it:
    // e.g. the user is on a blank line and typed _ — treat as continuation.
    if (beforeUnderscore.trim() === '') { return true; }

    return LINE_CONTINUATION_BEFORE_PATTERNS.some(p => p.test(beforeUnderscore));
}

// ── Suppress suggestions on line-continuation _ ───────────────────────────
// onDidChangeTextDocument fires synchronously after every edit, before VS Code
// has a chance to show the (stale) cached completion list.  If the typed char
// is _ and the line context says it's a continuation, we immediately call
// hideSuggestWidget so the popup never appears.

export function registerLineContinuationGuard(context: vscode.ExtensionContext) {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) { return; }
        if (event.document.languageId !== 'asp')           { return; }
        if (event.contentChanges.length === 0)             { return; }

        const change = event.contentChanges[0];

        // Only care when the character typed was _
        if (change.text !== '_') { return; }

        const lineNo    = change.range.start.line;
        const line      = event.document.lineAt(lineNo);
        // Text up to and including the newly typed _
        const lineUpTo  = line.text.substring(0, change.range.start.character + 1);

        if (isLineContinuation(lineUpTo)) {
            // Hide the suggestion widget. We fire twice — once immediately
            // (catches the cached list) and once after a short delay (catches
            // the freshly-invoked list that VS Code may show after the edit).
            vscode.commands.executeCommand('hideSuggestWidget');
            setTimeout(() => vscode.commands.executeCommand('hideSuggestWidget'), 50);
        }
    });

    context.subscriptions.push(disposable);
}

// ── Auto-closing tag + auto-snap VBScript closers ──────────────────────────

export function registerAutoClosingTag(context: vscode.ExtensionContext) {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) { return; }
        if (event.document.languageId !== 'asp')           { return; }
        if (event.contentChanges.length === 0)             { return; }

        const change = event.contentChanges[0];

        // ---- HTML comment auto-close: <!-- → <!-- | -->
        if (change.text === '-' && change.range.start.character >= 3) {
            const position  = change.range.start;
            const line      = event.document.lineAt(position.line);
            const textBefore = line.text.substring(0, position.character + 1);

            if (textBefore.endsWith('<!--')) {
                const textAfter = line.text.substring(position.character + 1);
                if (!textAfter.trim().startsWith('-->')) {
                    const insertPos = new vscode.Position(position.line, position.character + 1);
                    editor.edit(eb => eb.insert(insertPos, '  -->')).then(() => {
                        const p = new vscode.Position(position.line, position.character + 2);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
            }
            return;
        }

        // ---- HTML tag auto-close: <div> → <div></div>
        if (change.text === '>') {
            const position       = change.range.start;
            const line           = event.document.lineAt(position.line);
            const textBefore     = line.text.substring(0, position.character);
            const textAfterCursor = line.text.substring(position.character + 1);

            const tagMatch = textBefore.match(/<(\w+)(?:\s+[^>]*)?$/);
            if (tagMatch && !isSelfClosingTag(tagMatch[1])) {
                const expectedClosing = `</${tagMatch[1]}>`;
                if (!textAfterCursor.trim().startsWith(expectedClosing)) {
                    const insertPos = new vscode.Position(position.line, position.character + 1);
                    editor.edit(eb => eb.insert(insertPos, expectedClosing)).then(() => {
                        const p = new vscode.Position(position.line, position.character + 1);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
            }
            return;
        }

        // ---- Auto-snap VBScript closer to correct indent when fully typed
        // Skip deletions and whitespace-only changes (Tab/Shift+Tab)
        if (change.text === '' || !/\S/.test(change.text)) { return; }

        const changePos      = change.range.start;
        const currentLine    = event.document.lineAt(changePos.line);
        const currentTrimmed = currentLine.text.trim();
        const currentIndent  = currentLine.text.match(/^(\s*)/)?.[1] ?? '';
        const snapIndentUnit = getIndentUnit(editor);

        // Snap standalone %> to its matching <% indent
        if (currentTrimmed === '%>') {
            const aspOpenerIndent = findAspOpenerIndent(event.document, changePos.line);
            if (aspOpenerIndent !== null && aspOpenerIndent !== currentIndent) {
                editor.edit(eb => {
                    eb.replace(
                        new vscode.Range(
                            new vscode.Position(changePos.line, 0),
                            new vscode.Position(changePos.line, currentIndent.length)
                        ),
                        aspOpenerIndent
                    );
                }).then(() => {
                    const p = new vscode.Position(changePos.line, aspOpenerIndent.length + currentTrimmed.length);
                    editor.selection = new vscode.Selection(p, p);
                });
            }
            return;
        }

        if (!VBSCRIPT_EXACT_CLOSER.test(currentTrimmed)) { return; }
        if (!isInAspBlock(event.document, new vscode.Position(changePos.line, currentLine.text.length))) { return; }

        const openerIndent = findMatchingOpenerIndent(event.document, changePos.line, currentTrimmed, snapIndentUnit);
        if (openerIndent === null || openerIndent === currentIndent) { return; }

        editor.edit(eb => {
            eb.replace(
                new vscode.Range(
                    new vscode.Position(changePos.line, 0),
                    new vscode.Position(changePos.line, currentIndent.length)
                ),
                openerIndent
            );
        }).then(() => {
            const p = new vscode.Position(changePos.line, openerIndent.length + currentTrimmed.length);
            editor.selection = new vscode.Selection(p, p);
        });
    });

    context.subscriptions.push(disposable);
}

// ── Enter key handler ──────────────────────────────────────────────────────

export function registerEnterKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertLineBreak', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('default:type', { text: '\n' });
        }

        const position        = editor.selection.active;
        const document        = editor.document;
        const line            = document.lineAt(position.line);
        const textBefore      = line.text.substring(0, position.character);
        const textAfter       = line.text.substring(position.character);
        const currentLineText = textBefore.trim();
        const indent          = textBefore.match(/^(\s*)/)?.[0] || '';
        const indentUnit      = getIndentUnit(editor);

        // ── ASP / VBScript block handling ───────────────────────────────

        // Expand <%|%> on Enter.
        // VBScript code sits at the same indent as <% itself — no extra level.
        // <% and %> are at HTML child level; code between them is at that same level.
        if (/^<%=?\s*$/.test(textBefore.trim()) && textAfter.trimEnd() === '%>') {
            editor.edit(eb => {
                eb.replace(
                    new vscode.Range(position, new vscode.Position(position.line, line.text.length)),
                    `\n${indent}\n${indent}%>`
                );
            }).then(() => {
                const p = new vscode.Position(position.line + 1, indent.length);
                editor.selection = new vscode.Selection(p, p);
            });
            return;
        }

        // Standalone %> on Enter:
        //   1. Snap %> to its matching <% indent (if misaligned).
        //   2. The newline after %> re-enters HTML context — use the enclosing
        //      HTML opener's child indent so the next <li> etc. lands correctly.
        //      Falls back to targetIndent (same as %>) if no HTML opener is found.
        if (currentLineText === '%>') {
            const aspOpenerIndent  = findAspOpenerIndent(document, position.line);
            const targetIndent     = aspOpenerIndent !== null ? aspOpenerIndent : indent;
            // After %>, we're back in HTML — find what indent the next HTML child should use
            const htmlChildIndent  = findEnclosingHtmlChildIndent(document, position.line, indentUnit)
                                     ?? targetIndent;
            if (targetIndent !== indent) {
                const lineEnd = new vscode.Position(position.line, indent.length + currentLineText.length);
                editor.edit(eb => {
                    eb.replace(
                        new vscode.Range(new vscode.Position(position.line, 0), lineEnd),
                        `${targetIndent}${currentLineText}\n${htmlChildIndent}`
                    );
                }).then(() => {
                    const p = new vscode.Position(position.line + 1, htmlChildIndent.length);
                    editor.selection = new vscode.Selection(p, p);
                });
            } else {
                editor.edit(eb => eb.insert(position, `\n${htmlChildIndent}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, htmlChildIndent.length);
                    editor.selection = new vscode.Selection(p, p);
                });
            }
            return;
        }


        if (isInAspBlock(document, position)) {

            // After <% or <%= on its own line: VBScript code sits at the same indent
            // as <% itself — no extra level added. <% is at HTML child level and
            // VBScript lines sit flush with it.
            if (/^<%=?$/.test(currentLineText)) {
                editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }

            // Mid-block keyword (ElseIf, Else, Case, Case Else):
            // Snap the current line to its opener's indent level, then give +1 on next line.
            // Always use openerIndent as the base for the next line — even if the current line
            // failed to snap (e.g. typed without triggering auto-snap), so the body indent is
            // always openerIndent + 1 regardless of where the mid-block line physically sits.
            if (VBSCRIPT_MID_BLOCK.test(currentLineText)) {
                const openerIndent = findMatchingOpenerIndent(document, position.line, currentLineText, indentUnit);
                const targetIndent = openerIndent !== null ? openerIndent : indent;
                const bodyIndent   = targetIndent + indentUnit;

                if (targetIndent !== indent) {
                    // Current line is at the wrong indent — fix it and set cursor
                    const lineEnd = new vscode.Position(position.line, indent.length + currentLineText.length);
                    editor.edit(eb => {
                        eb.replace(
                            new vscode.Range(new vscode.Position(position.line, 0), lineEnd),
                            `${targetIndent}${currentLineText}\n${bodyIndent}`
                        );
                    }).then(() => {
                        const p = new vscode.Position(position.line + 1, bodyIndent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                } else {
                    editor.edit(eb => eb.insert(position, `\n${bodyIndent}`)).then(() => {
                        const p = new vscode.Position(position.line + 1, bodyIndent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
                return;
            }

            // Pure block closer (End If, Next, Loop, Wend, …):
            // Snap current line to opener indent, newline at same level.
            if (VBSCRIPT_BLOCK_CLOSERS.test(currentLineText)) {
                const openerIndent = findMatchingOpenerIndent(document, position.line, currentLineText, indentUnit);
                const targetIndent = openerIndent !== null ? openerIndent : indent;

                if (targetIndent !== indent) {
                    const lineEnd = new vscode.Position(position.line, indent.length + currentLineText.length);
                    editor.edit(eb => {
                        eb.replace(
                            new vscode.Range(new vscode.Position(position.line, 0), lineEnd),
                            `${targetIndent}${currentLineText}\n${targetIndent}`
                        );
                    }).then(() => {
                        const p = new vscode.Position(position.line + 1, targetIndent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                } else {
                    editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
                        const p = new vscode.Position(position.line + 1, indent.length);
                        editor.selection = new vscode.Selection(p, p);
                    });
                }
                return;
            }

            // Line continuation (_) → next line gets +1 indent.
            // In VBScript, a trailing _ (preceded by whitespace, or
            // the whole trimmed line is _) means the statement continues
            // on the next line. Indent one extra level so the continuation
            // is visually grouped under the opening line.
            if (/(?:^|\s)_\s*$/.test(currentLineText)) {
                editor.edit(eb => eb.insert(position, '\n' + indent + indentUnit)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }

            // Block opener → next line +1
            if (VBSCRIPT_BLOCK_OPENERS.test(currentLineText)) {
                editor.edit(eb => eb.insert(position, `\n${indent}${indentUnit}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }

            // Default inside ASP → match current indent
            editor.edit(eb => eb.insert(position, `\n${indent}`)).then(() => {
                const p = new vscode.Position(position.line + 1, indent.length);
                editor.selection = new vscode.Selection(p, p);
            });
            return;
        }

        // ── HTML context handling ───────────────────────────────────────

        // HTML comment: <!-- | -->
        if (textBefore.trim().endsWith('<!--') && textAfter.trim().startsWith('-->')) {
            editor.edit(eb => {
                eb.replace(new vscode.Range(position, line.range.end),
                    `\n${indent}${indentUnit}\n${indent}-->`);
            }).then(() => {
                const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                editor.selection = new vscode.Selection(p, p);
            });
            return;
        }

        // Closed tag: <div>|</div>  or  <div>| with closing tag elsewhere
        const justClosedTagMatch = textBefore.match(/<(\w+)([^>]*)>$/);
        if (justClosedTagMatch) {
            const tagName = justClosedTagMatch[1];

            if (!isSelfClosingTag(tagName)) {
                const closingTag      = `</${tagName}>`;
                const closingTagRegex = new RegExp(`</${tagName}>`, 'i');
                // Only getText from cursor to end — avoids scanning the whole document
                const afterCursorText = document.getText(
                    new vscode.Range(position, document.lineAt(document.lineCount - 1).range.end)
                );

                if (closingTagRegex.test(afterCursorText)) {
                    if (textAfter.trim().startsWith(closingTag)) {
                        // <div>|</div> → expand
                        editor.edit(eb => {
                            eb.replace(new vscode.Range(position, line.range.end),
                                `\n${indent}${indentUnit}\n${indent}${closingTag}`);
                        }).then(() => {
                            const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                            editor.selection = new vscode.Selection(p, p);
                        });
                    } else {
                        editor.edit(eb => eb.insert(position, `\n${indent}${indentUnit}`)).then(() => {
                            const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                            editor.selection = new vscode.Selection(p, p);
                        });
                    }
                    return;
                }

                // No closing tag — create it
                editor.edit(eb => eb.insert(position, `\n${indent}${indentUnit}\n${indent}${closingTag}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }
        }

        // Incomplete tag: <div|
        const incompleteTagMatch = textBefore.match(/<(\w+)([^>]*)$/);
        if (incompleteTagMatch && !textBefore.endsWith('>')) {
            const tagName = incompleteTagMatch[1];
            if (!isSelfClosingTag(tagName)) {
                const closingTag = `</${tagName}>`;
                editor.edit(eb => eb.insert(position, `>\n${indent}${indentUnit}\n\n${indent}${closingTag}`)).then(() => {
                    const p = new vscode.Position(position.line + 1, indent.length + indentUnit.length);
                    editor.selection = new vscode.Selection(p, p);
                });
                return;
            }
        }

        return vscode.commands.executeCommand('default:type', { text: '\n' });
    });

    context.subscriptions.push(disposable);
}

// ── Tab key handler ────────────────────────────────────────────────────────

export function registerTabKeyHandler(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('asp.insertTab', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'asp') {
            return vscode.commands.executeCommand('tab');
        }

        const position = editor.selection.active;
        const lineText = editor.document.lineAt(position.line).text;

        // Only apply smart indent on a completely blank line
        if (lineText.trim() !== '') {
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
        const inAsp = isInAspBlock(editor.document, position);

        let targetIndent: string;
        if (prevLineText === '%>') {
            // After a closing %> fragment delimiter, we're back in HTML context.
            // Use the enclosing HTML opener's child indent — same logic as Enter after %>.
            targetIndent = findEnclosingHtmlChildIndent(editor.document, position.line, indentUnit)
                           ?? baseIndent;
        } else if (/^<%/.test(prevLineText)) {
            // After <% — VBScript code is at the same level as <%, no extra indent
            targetIndent = baseIndent;
        } else if (inAsp && VBSCRIPT_BLOCK_OPENERS.test(prevLineText)) {
            targetIndent = baseIndent + indentUnit;
        } else if (inAsp) {
            targetIndent = baseIndent;
        } else {
            // Plain HTML / <script> / <style>:
            // Add one extra level when the previous line opens a block.
            // A JS/CSS block opener ends with '{'.
            // An HTML block opener ends with '>' and is a non-self-closing, non-inline tag.
            const INLINE_OR_VOID = /^(a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr|img|input|link|meta|hr|area|base|col|embed|param|source|track)$/i;
            const htmlOpenerMatch = prevLineText.match(/^<(\w+)(\s[^>]*)?>$/);
            const isHtmlOpener = htmlOpenerMatch
                && !INLINE_OR_VOID.test(htmlOpenerMatch[1])
                && !isSelfClosingTag(htmlOpenerMatch[1]);
            const opensBlock = prevLineText.endsWith('{') || !!isHtmlOpener;
            targetIndent = opensBlock ? baseIndent + indentUnit : baseIndent;
        }

        // Snap up to correct level if below it, otherwise freely +1
        const newIndent = currentIndent.length < targetIndent.length
            ? targetIndent
            : currentIndent + indentUnit;

        editor.edit(eb => {
            eb.replace(new vscode.Range(new vscode.Position(position.line, 0), position), newIndent);
        }).then(() => {
            const p = new vscode.Position(position.line, newIndent.length);
            editor.selection = new vscode.Selection(p, p);
        });
    });

    context.subscriptions.push(disposable);
}