/**
 * htmlStructure.ts  (core/)
 *
 * Finds mismatched structural HTML tags in an ASP page: the ones commonly
 * forgotten that also break the Prettier-based formatter —
 *   div, table, form, section, nav, ul, ol, select, fieldset, figure, details,
 *   summary, article, aside, header, footer, main, dialog
 * — and closing tags of void elements (`</br>`).
 *
 * The tags are the HTML scanner's (zoneUtils' scanMarkup), so the inside of
 * <!-- … --> comments, <% … %> blocks, <script> and <style> is skipped as a .html
 * file skips it, and so are self-closing tags. A tag pair split across the
 * branches of a VBScript If or Select is read the way the page runs.
 *
 * Free of vscode: the structure diagnostics (html/htmlStructureDiagnosticsProvider)
 * report what this finds, and the formatter reads it to know which tags it must
 * leave alone.
 */

import { pageBlocks, type BlockEvent } from '../vbscript/pageAnalysis';
import { parsePage } from '../vbscript/symbols';
import { VOID_ELEMENTS } from '../constants/htmlTags';
import { inRanges, scanMarkup } from './zoneUtils';

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
 *
 * The If / Select Case structure comes from the VBScript syntax tree:
 * `events` when the caller already has them (the VBScript worker read them),
 * otherwise the page is parsed here.
 *
 * `tracked` says which elements are followed: the structural ones by default,
 * as the diagnostics want; the formatter hides a branch's copy of any element.
 */
export function analyseHtmlStructure(
    fullText: string, events?: BlockEvent[], tracked: (name: string) => boolean = name => STRUCTURAL_TAGS.has(name),
): HtmlStructure {
    const branchEvents = (events ?? pageBlocks(parsePage(fullText)).events).filter(e => e.block !== 'other');
    let nextEvent = 0;
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
                if (!tracked(name)) { continue; }
                written.set(name, (written.get(name) ?? 0) + (m[1] ? -1 : 1));
            }
        }
    };

    // The page's tags, as the HTML scanner reads them over the page with its ASP
    // blanked: one inside a comment, a <script> or a <style>, or written by ASP
    // into an attribute value, is not a tag.
    const markup    = scanMarkup(fullText);
    const rawBodies = [...markup.scripts, ...markup.styles].sort((a, b) => a.start - b.start);
    let nextTag = 0;

    const readTagsBefore = (until: number): void => {
        for (; nextTag < markup.tags.length && markup.tags[nextTag].start < until; nextTag++) {
            const tag = markup.tags[nextTag];
            if (!tag.name || tag.name === 'script' || tag.name === 'style') { continue; }
            if (tag.close && VOID_ELEMENTS.has(tag.name)) {
                voids.push({
                    start: tag.start, end: tag.end, kind: 'void', name: tag.name, tag: { start: tag.start, end: tag.end },
                    message: `</${tag.name}> is invalid — <${tag.name}> is a void element and cannot have a closing tag.`,
                });
                continue;
            }
            if (!tracked(tag.name) || tag.selfClosing) { continue; }
            record(tag.close
                ? { type: 'close', name: tag.name, start: tag.start, end: tag.end }
                : { type: 'open',  entry: { name: tag.name, start: tag.start, end: tag.end } });
        }
    };

    // ── ASP blocks, in page order with the tags — their If / Else / End If shape the branches
    for (const block of markup.aspBlocks) {
        readTagsBefore(block.start);
        // A block inside a tag's attributes or a comment writes no markup structure.
        const lastTag = markup.tags[nextTag - 1];
        if (lastTag && lastTag.end > block.start) { continue; }
        if (inRanges(markup.comments, block.start, true)) { continue; }

        const closed  = block.end - 2 >= block.start + 2 && fullText.startsWith('%>', block.end - 2);
        const codeEnd = closed ? block.end - 2 : fullText.length;
        noteWrittenTags(fullText.slice(block.start + 2, codeEnd));
        const inRawText = inRanges(rawBodies, block.start, false);
        while (nextEvent < branchEvents.length && branchEvents[nextEvent].at < block.start) { nextEvent++; }
        for (; nextEvent < branchEvents.length && branchEvents[nextEvent].at < codeEnd; nextEvent++) {
            if (inRawText) { continue; }
            const event = branchEvents[nextEvent];
            const kind  = event.block as 'if' | 'select';
            if (event.type === 'open')        { openBranch(kind); }
            else if (event.type === 'branch') { nextBranch(kind); }
            else                              { closeBranch(kind); }
        }
    }
    readTagsBefore(Infinity);

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
