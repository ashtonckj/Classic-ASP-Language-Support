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
import { branchEvents } from './aspStructureDiagnosticsProvider';

// ── Structural tags we care about ────────────────────────────────────────────

// Only elements that REQUIRE a closing tag belong here. Table cells/rows/sections
// (tr, td, th, thead, tbody, tfoot) and list items have OPTIONAL end tags per the
// HTML spec, so a "missing" </td> or </tr> is never an error — flagging them
// flooded valid tables with false "Missing closing tag" warnings (which also
// blocked Format Document, since formatting is refused while diagnostics exist).
export const STRUCTURAL_TAGS = new Set([
    'div', 'table', 'form', 'section', 'nav',
    'ul', 'ol',
    'select', 'fieldset', 'figure', 'details', 'summary',
    'article', 'aside', 'header', 'footer', 'main', 'dialog',
]);

const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export const VOID_ELEMENT_DIAGNOSTIC_CODE = 'voidElementClosingTag';

// Sticky (/y) close-tag matchers for the raw-text elements. Anchoring at
// lastIndex tests in place; the previous `fullText.slice(i)` built a copy of the
// whole remaining document for EVERY character inside a <script> or <style>
// body, making the scan quadratic in file size. lastIndex is set before each
// use, so sharing one regex across calls is safe.
const SCRIPT_CLOSE_RE = /<\/script\s*>/iy;
const STYLE_CLOSE_RE  = /<\/style\s*>/iy;

/** True when a raw-text close tag starts exactly at `i`. */
function closesAt(re: RegExp, text: string, i: number): boolean {
    if (text[i] !== '<') { return false; }
    re.lastIndex = i;
    return re.test(text);
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A structural opening tag, waiting for its closer. */
interface TagEntry {
    name:  string;
    /** The whole opening tag, `<div …>`. */
    start: number;
    end:   number;
}

/** A problem in the page's tag structure, as offsets into the text. */
export interface StructureIssue {
    /** What to underline. */
    start:   number;
    end:     number;
    message: string;
    kind:    'stray' | 'missing' | 'void';
    name:    string;
    /** The whole tag the issue is about. */
    tag:     { start: number; end: number };
}

/**
 * A tag the formatter has to keep out of Prettier's sight. Either it is one
 * branch's copy of a tag the first branch of the same If already opens or
 * closes, or its partner is written by VBScript (`Response.Write "<table>"`).
 * The page nests correctly when it runs, but not read top to bottom, and
 * Prettier — which does read it top to bottom — would otherwise re-nest it or
 * append a closing tag of its own.
 *
 * `dedent` is how many levels shallower than where Prettier puts it the tag
 * belongs, since Prettier lays it out inside the first branch's element.
 */
export interface HiddenTag { start: number; end: number; dedent: number; }

export interface HtmlStructure {
    issues: StructureIssue[];
    hidden: HiddenTag[];
}

type TagEvent =
    | { type: 'open';  entry: TagEntry }
    | { type: 'close'; name: string; start: number; end: number };

/** An If or a Select Case being read, with the tag stack each branch left. */
interface BranchFrame {
    block: 'if' | 'select';
    /** The tag stack the branches start from. */
    entry: TagEntry[];
    /** The stack each finished branch ended with. */
    ends:  TagEntry[][];
    /** Select Case: the first Case begins the first branch. */
    started: boolean;
    /** Event-log index where each branch after the first begins. */
    branchStarts: number[];
    /** Where the second branch began, in the issue and hidden-tag lists. */
    issueStart:  number;
    hiddenStart: number;
    /** A nested If with branches of its own sits in one of the later branches. */
    branchyChild: boolean;
}

// ── Main scanner ──────────────────────────────────────────────────────────────

/**
 * The structure of the page's markup, read the way the page runs.
 *
 * Tags inside ASP blocks, <script>, <style> and HTML comments are ignored. The
 * branches of an If (or the Cases of a Select Case) are alternatives, not one
 * after another, so
 *
 *     <% If admin Then %><div class="admin"><% Else %><div class="user"><% End If %>
 *     …
 *     </div>
 *
 * opens ONE div, whichever branch runs. When every branch leaves the same tags
 * open, the page is read that way; when they disagree, it is read top to
 * bottom, exactly as it was before branches were understood, so no warning is
 * lost that the plain reading would have given.
 *
 * A tag whose partner is written by VBScript — `Response.Write "<table>"`
 * before a `</table>` in the markup — is not reported either.
 */
export function analyseHtmlStructure(fullText: string): HtmlStructure {
    let   issues: StructureIssue[] = [];
    const voids:  StructureIssue[] = [];
    let   hidden: HiddenTag[]      = [];

    // Stack of open structural tags waiting for their closer
    let stack: TagEntry[] = [];

    const log:    TagEvent[]    = [];
    const frames: BranchFrame[] = [];

    // Per structural tag name, how many more of it VBScript strings open than
    // close — so a string that writes a whole table excuses nothing.
    const written = new Map<string, number>();

    const open = (entry: TagEntry): void => { stack.push(entry); };

    const close = (name: string, start: number, end: number): void => {
        // Walk back through the stack to find the nearest matching opener
        let matched = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].name === name) { matched = s; break; }
        }

        if (matched === -1) {
            // No matching opener anywhere — stray closer
            issues.push({
                start, end, kind: 'stray', name, tag: { start, end },
                message: `Unexpected closing tag — no opening <${name}> found for this </${name}>`,
            });
            return;
        }

        // Everything above the match is a structural opener that was never
        // closed (e.g. <div><section></div> — the section is left open).
        for (let s = stack.length - 1; s > matched; s--) { missing(stack[s]); }
        stack.splice(matched); // remove matched and everything above it
    };

    const missing = (entry: TagEntry): void => {
        issues.push({
            start: entry.start, end: entry.start + entry.name.length + 1,
            kind: 'missing', name: entry.name, tag: { start: entry.start, end: entry.end },
            message: `Missing closing tag — no </${entry.name}> found for this <${entry.name}>`,
        });
    };

    const apply = (event: TagEvent): void => {
        if (event.type === 'open') { open(event.entry); }
        else { close(event.name, event.start, event.end); }
    };

    const sameNames = (a: TagEntry[], b: TagEntry[]) =>
        a.length === b.length && a.every((entry, i) => entry.name === b[i].name);

    /**
     * The tags of one later branch that change what is open — the ones that
     * close something the branch started with, and the ones still open when it
     * ends — which are exactly the ones Prettier must not see twice.
     */
    const branchHiddenTags = (frame: BranchFrame, from: number, to: number): HiddenTag[] => {
        const first     = frame.ends[0];
        const entrySet  = new Set(frame.entry);
        let   kept      = 0;
        while (kept < first.length && kept < frame.entry.length && first[kept] === frame.entry[kept]) { kept++; }
        const firstPops  = frame.entry.length - kept;
        const firstOpens = first.length - kept;

        const tags: HiddenTag[] = [];
        const sim = frame.entry.slice();
        const opened = new Map<TagEntry, number>();   // entry → index into tags
        let pops = 0;
        let opens = 0;

        for (let e = from; e < to; e++) {
            const event = log[e];
            if (event.type === 'open') {
                sim.push(event.entry);
                opened.set(event.entry, tags.length);
                tags.push({ start: event.entry.start, end: event.entry.end, dedent: firstOpens - firstPops + pops - opens });
                opens++;
                continue;
            }
            let matched = -1;
            for (let s = sim.length - 1; s >= 0; s--) {
                if (sim[s].name === event.name) { matched = s; break; }
            }
            if (matched === -1) { continue; }
            const target = sim[matched];
            if (entrySet.has(target)) {
                tags.push({ start: event.start, end: event.end, dedent: firstOpens - firstPops + 1 + pops });
                pops++;
            } else {
                // Opened and closed inside the branch: Prettier may see both.
                const at = opened.get(target);
                if (at !== undefined) { tags[at] = { ...tags[at], dedent: NaN }; }
                opens--;
            }
            sim.splice(matched);
        }
        return tags.filter(tag => !Number.isNaN(tag.dedent));
    };

    const openBranch = (block: 'if' | 'select'): void => {
        frames.push({
            block, entry: stack.slice(), ends: [], started: block === 'if',
            branchStarts: [], issueStart: -1, hiddenStart: -1, branchyChild: false,
        });
    };

    const nextBranch = (block: 'if' | 'select'): void => {
        const frame = frames[frames.length - 1];
        if (!frame || frame.block !== block) { return; }
        if (!frame.started) {
            // Tags before a Select Case's first Case are in no branch.
            frame.started = true;
            frame.entry = stack.slice();
            return;
        }
        frame.ends.push(stack.slice());
        if (frame.branchStarts.length === 0) {
            frame.issueStart  = issues.length;
            frame.hiddenStart = hidden.length;
        }
        frame.branchStarts.push(log.length);
        stack = frame.entry.slice();
    };

    const closeBranch = (block: 'if' | 'select'): void => {
        const frame = frames[frames.length - 1];
        if (!frame || frame.block !== block) { return; }
        frames.pop();
        if (frame.branchStarts.length === 0) { return; }   // one branch: nothing to choose

        frame.ends.push(stack.slice());
        const parent = frames[frames.length - 1];
        if (parent && parent.branchStarts.length > 0) { parent.branchyChild = true; }

        // Every branch leaves the same tags open: read it as one of them.
        if (!frame.branchyChild && frame.ends.every(end => sameNames(end, frame.ends[0]))) {
            stack = frame.ends[0].slice();
            frame.branchStarts.forEach((from, b) => {
                const to = frame.branchStarts[b + 1] ?? log.length;
                hidden.push(...branchHiddenTags(frame, from, to));
            });
            return;
        }

        // They disagree: read the branches top to bottom, the plain way.
        issues = issues.slice(0, frame.issueStart);
        hidden = hidden.slice(0, frame.hiddenStart);
        stack  = frame.ends[0].slice();
        for (let e = frame.branchStarts[0]; e < log.length; e++) { apply(log[e]); }
    };

    const record = (event: TagEvent): void => { log.push(event); apply(event); };

    /** Notes the structural tags a VBScript string literal opens or closes. */
    const noteWrittenTags = (code: string): void => {
        const strings = code.match(/"(?:[^"\n]|"")*"/g) ?? [];
        for (const literal of strings) {
            for (const m of literal.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)/g)) {
                const name = m[2].toLowerCase();
                if (!STRUCTURAL_TAGS.has(name)) { continue; }
                written.set(name, (written.get(name) ?? 0) + (m[1] ? -1 : 1));
            }
        }
    };

    // Track skipped zones so we don't match tags inside ASP/script/style/comments
    let inHtmlComment = false;
    let inScript      = false;
    let inStyle       = false;

    let i = 0;

    while (i < fullText.length) {

        // ── HTML comment  <!-- ... --> ────────────────────────────────────────
        if (!inHtmlComment && fullText[i] === '<' && fullText.startsWith('<!--', i)) {
            inHtmlComment = true;
            i += 4;
            continue;
        }
        if (inHtmlComment) {
            if (fullText.startsWith('-->', i)) { inHtmlComment = false; i += 3; }
            else { i++; }
            continue;
        }

        // ── ASP block  <% ... %> — its If / Else / End If shape the branches ──
        if (fullText[i] === '<' && fullText[i + 1] === '%') {
            const closeAt = fullText.indexOf('%>', i + 2);
            const code    = fullText.slice(i + 2, closeAt === -1 ? fullText.length : closeAt);
            noteWrittenTags(code);
            if (!inScript && !inStyle && !/^[=@]/.test(code.trimStart())) {
                for (const event of branchEvents(code)) {
                    if (event.type === 'open')        { openBranch(event.block); }
                    else if (event.type === 'branch') { nextBranch(event.block); }
                    else                              { closeBranch(event.block); }
                }
            }
            i = closeAt === -1 ? fullText.length : closeAt + 2;
            continue;
        }

        // ── Skip script / style block content ────────────────────────────────
        if (inScript) {
            if (closesAt(SCRIPT_CLOSE_RE, fullText, i)) { inScript = false; }
            i++;
            continue;
        }
        if (inStyle) {
            if (closesAt(STYLE_CLOSE_RE, fullText, i)) { inStyle = false; }
            i++;
            continue;
        }

        // ── HTML tag ──────────────────────────────────────────────────────────
        if (fullText[i] !== '<') { i++; continue; }

        // A `<` with no tag-name character after it is literal body text
        // ("Total: 5 < 10"), not markup. Scanning it to the next `>` consumed the
        // real closing tag that followed and produced a false "Missing closing
        // tag" — which in turn blocks Format Document.
        const afterAngle = fullText[i + 1];
        if (afterAngle === undefined || !/[A-Za-z/!?]/.test(afterAngle)) { i++; continue; }

        // Collect the full tag (up to next >), skipping ASP blocks inside attrs
        let tagEnd = i + 1;
        let inStr: string | null = null;
        while (tagEnd < fullText.length) {
            const ch = fullText[tagEnd];
            if (inStr) {
                if (ch === inStr) inStr = null;
                tagEnd++;
                continue;
            }
            if (ch === '"' || ch === "'") { inStr = ch; tagEnd++; continue; }
            // Skip embedded ASP blocks inside attributes: <tag attr="<%= x %>">
            if (ch === '<' && fullText[tagEnd + 1] === '%') {
                while (tagEnd < fullText.length) {
                    if (fullText[tagEnd] === '%' && fullText[tagEnd + 1] === '>') { tagEnd += 2; break; }
                    tagEnd++;
                }
                continue;
            }
            if (ch === '>') { tagEnd++; break; }
            tagEnd++;
        }

        const raw     = fullText.slice(i, tagEnd);
        const isClose = raw.startsWith('</');

        // Extract tag name
        const nameMatch = raw.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
        if (!nameMatch) { i = tagEnd; continue; }
        const tagName = nameMatch[1].toLowerCase();

        // Track script/style zones
        if (!isClose && tagName === 'script') { inScript = true; i = tagEnd; continue; }
        if (!isClose && tagName === 'style')  { inStyle  = true; i = tagEnd; continue; }

        // ── Void element closing tag check ────────────────────────────────────
        if (isClose && VOID_ELEMENTS.has(tagName)) {
            voids.push({
                start: i, end: tagEnd, kind: 'void', name: tagName, tag: { start: i, end: tagEnd },
                message: `</${tagName}> is invalid — <${tagName}> is a void element and cannot have a closing tag.`,
            });
            i = tagEnd;
            continue;
        }

        // Only care about structural tags, and not a self-closed <tag />
        if (STRUCTURAL_TAGS.has(tagName) && !raw.trimEnd().endsWith('/>')) {
            record(isClose
                ? { type: 'close', name: tagName, start: i, end: tagEnd }
                : { type: 'open',  entry: { name: tagName, start: i, end: tagEnd } });
        }

        i = tagEnd;
    }

    // An If still open at the end of the page (its own warning says so) is
    // resolved as though it closed there.
    while (frames.length > 0) { closeBranch(frames[frames.length - 1].block); }

    // ── Anything left in the stack is unclosed ────────────────────────────────
    for (const entry of stack) { missing(entry); }

    // A tag whose partner VBScript writes is fine, and hidden from Prettier,
    // which cannot see the partner.
    const writtenPartner = (issue: StructureIssue) =>
        (issue.kind === 'stray' && (written.get(issue.name) ?? 0) > 0)
        || (issue.kind === 'missing' && (written.get(issue.name) ?? 0) < 0);
    for (const issue of issues) {
        if (writtenPartner(issue)) { hidden.push({ ...issue.tag, dedent: 0 }); }
    }

    // A branch can report the same tag as another branch did.
    const seen = new Set<string>();
    const unique = issues.filter(issue => {
        if (writtenPartner(issue)) { return false; }
        const key = `${issue.start}:${issue.end}:${issue.message}`;
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });

    const hiddenSeen = new Set<number>();
    hidden = hidden
        .filter(tag => !hiddenSeen.has(tag.start) && hiddenSeen.add(tag.start))
        .sort((a, b) => a.start - b.start);

    return { issues: [...unique, ...voids].sort((a, b) => a.start - b.start), hidden };
}

export function scanHtmlStructure(document: vscode.TextDocument): vscode.Diagnostic[] {
    return analyseHtmlStructure(document.getText()).issues.map(issue => {
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
            issue.message,
            issue.kind === 'void' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'Classic ASP (HTML)';
        if (issue.kind === 'void') { diagnostic.code = VOID_ELEMENT_DIAGNOSTIC_CODE; }
        return diagnostic;
    });
}

// ── Quick-fix code action provider ───────────────────────────────────────────

export class VoidElementQuickFixProvider implements vscode.CodeActionProvider {

    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        _range:   vscode.Range,
        context:  vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        return context.diagnostics
            .filter(d => d.code === VOID_ELEMENT_DIAGNOSTIC_CODE)
            .map(diag => {
                const tagText = document.getText(diag.range);
                const action  = new vscode.CodeAction(
                    `Remove \`${tagText}\``,
                    vscode.CodeActionKind.QuickFix
                );
                action.edit        = new vscode.WorkspaceEdit();
                action.edit.delete(document.uri, diag.range);
                action.diagnostics = [diag];
                action.isPreferred = true;
                return action;
            });
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerHtmlStructureDiagnostics(
    context: vscode.ExtensionContext
): vscode.DiagnosticCollection {

    const collection = vscode.languages.createDiagnosticCollection('classic-asp-html-structure');
    context.subscriptions.push(collection);

    // Per-document debounce timers, keyed by URI, so editing one open .asp file
    // never cancels another file's pending scan (a single shared timer did).
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function schedule(document: vscode.TextDocument): void {
        if (document.languageId !== 'asp') { return; }
        const key = document.uri.toString();
        const existing = debounceTimers.get(key);
        if (existing) { clearTimeout(existing); }
        debounceTimers.set(key, setTimeout(() => {
            debounceTimers.delete(key);
            collection.set(document.uri, scanHtmlStructure(document));
        }, 1500));
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
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            const existing = debounceTimers.get(key);
            if (existing) { clearTimeout(existing); debounceTimers.delete(key); }
            collection.delete(doc.uri);
        }),
    );

    // Cancel any pending timers on deactivate.
    context.subscriptions.push({
        dispose: () => {
            for (const timer of debounceTimers.values()) { clearTimeout(timer); }
            debounceTimers.clear();
        },
    });

    return collection;
}