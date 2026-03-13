/**
 * htmlStructureDiagnosticsProvider.ts
 *
 * Detects mismatched structural HTML tags inside .asp files and reports them
 * as Warning diagnostics (orange squiggles).
 *
 * Checks only the structural tags that are commonly forgotten and will break
 * the Prettier-based formatter:
 *   div, table, form, section, nav, ul, ol, thead, tbody, tfoot, tr, td, th,
 *   select, fieldset, figure, details, summary, article, aside, header, footer,
 *   main, dialog
 *
 * Skips:
 *  - Content inside <!-- ... --> HTML comments
 *  - Content inside <% ... %> ASP blocks
 *  - Content inside <script> and <style> blocks
 *  - Self-closing tags
 *
 * Debounced at 1500 ms so it doesn't fire on every keystroke.
 */

import * as vscode from 'vscode';

// ── Structural tags we care about ────────────────────────────────────────────

const STRUCTURAL_TAGS = new Set([
    'div', 'table', 'form', 'section', 'nav',
    'ul', 'ol', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'select', 'fieldset', 'figure', 'details', 'summary',
    'article', 'aside', 'header', 'footer', 'main', 'dialog',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

interface TagEntry {
    name:  string;
    line:  number;
    col:   number;
}

// ── Main scanner ──────────────────────────────────────────────────────────────

function scanHtmlStructure(document: vscode.TextDocument): vscode.Diagnostic[] {
    const text  = document.getText();
    const lines = text.split('\n');
    const diagnostics: vscode.Diagnostic[] = [];

    // Stack of open structural tags waiting for their closer
    const stack: TagEntry[] = [];

    // Track skipped zones so we don't match tags inside ASP/script/style/comments
    let inHtmlComment = false;
    let inAspBlock    = false;
    let inScript      = false;
    let inStyle       = false;

    let i = 0;

    while (i < text.length) {

        // ── HTML comment  <!-- ... --> ────────────────────────────────────────
        if (!inAspBlock && !inHtmlComment && text.slice(i, i + 4) === '<!--') {
            inHtmlComment = true;
            i += 4;
            continue;
        }
        if (inHtmlComment) {
            if (text.slice(i, i + 3) === '-->') { inHtmlComment = false; i += 3; }
            else { i++; }
            continue;
        }

        // ── ASP block  <% ... %> ─────────────────────────────────────────────
        if (!inAspBlock && text[i] === '<' && text[i + 1] === '%') {
            inAspBlock = true;
            i += 2;
            continue;
        }
        if (inAspBlock) {
            if (text[i] === '%' && text[i + 1] === '>') { inAspBlock = false; i += 2; }
            else { i++; }
            continue;
        }

        // ── Skip script / style block content ────────────────────────────────
        if (inScript) {
            if (/^<\/script\s*>/i.test(text.slice(i))) { inScript = false; }
            i++;
            continue;
        }
        if (inStyle) {
            if (/^<\/style\s*>/i.test(text.slice(i))) { inStyle = false; }
            i++;
            continue;
        }

        // ── HTML tag ──────────────────────────────────────────────────────────
        if (text[i] !== '<') { i++; continue; }

        // Collect the full tag (up to next >), skipping ASP blocks inside attrs
        let tagEnd = i + 1;
        let inStr: string | null = null;
        while (tagEnd < text.length) {
            const ch = text[tagEnd];
            if (inStr) {
                if (ch === inStr) inStr = null;
                tagEnd++;
                continue;
            }
            if (ch === '"' || ch === "'") { inStr = ch; tagEnd++; continue; }
            // Skip embedded ASP blocks inside attributes: <tag attr="<%= x %>">
            if (ch === '<' && text[tagEnd + 1] === '%') {
                while (tagEnd < text.length) {
                    if (text[tagEnd] === '%' && text[tagEnd + 1] === '>') { tagEnd += 2; break; }
                    tagEnd++;
                }
                continue;
            }
            if (ch === '>') { tagEnd++; break; }
            tagEnd++;
        }

        const raw     = text.slice(i, tagEnd);
        const isClose = raw.startsWith('</');

        // Extract tag name
        const nameMatch = raw.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
        if (!nameMatch) { i = tagEnd; continue; }
        const tagName = nameMatch[1].toLowerCase();

        // Track script/style zones
        if (!isClose && tagName === 'script') { inScript = true; i = tagEnd; continue; }
        if (!isClose && tagName === 'style')  { inStyle  = true; i = tagEnd; continue; }

        // Only care about structural tags
        if (!STRUCTURAL_TAGS.has(tagName)) { i = tagEnd; continue; }

        // Self-closing: <tag /> — ignore
        if (raw.trimEnd().endsWith('/>')) { i = tagEnd; continue; }

        // Get line/col of this tag in the document
        const tagPos = document.positionAt(i);

        if (!isClose) {
            // ── Opening tag — push onto stack ─────────────────────────────────
            stack.push({ name: tagName, line: tagPos.line, col: tagPos.character });
        } else {
            // ── Closing tag — try to match against stack ──────────────────────
            // Walk back through the stack to find the nearest matching opener
            let matched = -1;
            for (let s = stack.length - 1; s >= 0; s--) {
                if (stack[s].name === tagName) { matched = s; break; }
            }

            if (matched === -1) {
                // No matching opener anywhere — stray closer
                const range = new vscode.Range(tagPos, document.positionAt(tagEnd));
                diagnostics.push(Object.assign(
                    new vscode.Diagnostic(
                        range,
                        `Unexpected closing tag — no opening <${tagName}> found for this </${tagName}>`,
                        vscode.DiagnosticSeverity.Warning
                    ),
                    { source: 'Classic ASP (HTML)' }
                ));
            } else {
                // Pop everything above the match — those openers are unclosed
                // (e.g. <div><span></div> — the span is implicitly unclosed)
                // But we only squiggle structural tags so we just pop silently
                // for any non-structural ones that somehow got on the stack,
                // and squiggle structural ones that were skipped.
                // Since we only push structural tags, everything above `matched`
                // in the stack is a structural opener that was never closed.
                for (let s = stack.length - 1; s > matched; s--) {
                    const unclosed = stack[s];
                    const unclosedPos = new vscode.Position(unclosed.line, unclosed.col);
                    const unclosedEnd = new vscode.Position(unclosed.line, unclosed.col + unclosed.name.length + 1);
                    diagnostics.push(Object.assign(
                        new vscode.Diagnostic(
                            new vscode.Range(unclosedPos, unclosedEnd),
                            `Missing closing tag — no </${unclosed.name}> found for this <${unclosed.name}>`,
                            vscode.DiagnosticSeverity.Warning
                        ),
                        { source: 'Classic ASP (HTML)' }
                    ));
                }
                stack.splice(matched); // remove matched and everything above it
            }
        }

        i = tagEnd;
    }

    // ── Anything left in the stack is unclosed ────────────────────────────────
    for (const entry of stack) {
        const pos = new vscode.Position(entry.line, entry.col);
        const end = new vscode.Position(entry.line, entry.col + entry.name.length + 1);
        diagnostics.push(Object.assign(
            new vscode.Diagnostic(
                new vscode.Range(pos, end),
                `Missing closing tag — no </${entry.name}> found for this <${entry.name}>`,
                vscode.DiagnosticSeverity.Warning
            ),
            { source: 'Classic ASP (HTML)' }
        ));
    }

    return diagnostics;
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerHtmlStructureDiagnostics(
    context: vscode.ExtensionContext
): vscode.DiagnosticCollection {

    const collection = vscode.languages.createDiagnosticCollection('classic-asp-html-structure');
    context.subscriptions.push(collection);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    function schedule(document: vscode.TextDocument): void {
        if (document.languageId !== 'asp') { return; }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            collection.set(document.uri, scanHtmlStructure(document));
        }, 1500);
    }

    // Run immediately on already-open documents
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'asp') {
            collection.set(doc.uri, scanHtmlStructure(doc));
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(schedule),
        vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
    );

    return collection;
}