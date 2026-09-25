import * as vscode from 'vscode';
import type * as prettier from 'prettier';
import { formatSingleAspBlock, getAspSettings, delimitersAtColumnZero } from './aspFormatter';
import { findNextRealTag, findTagEnd, findClosingTag } from '../utils/zoneUtils';
import { analyseHtmlStructure } from '../providers/htmlStructureDiagnosticsProvider';
import { VOID_ELEMENTS } from '../constants/htmlTags';

// ─── Prettier settings ─────────────────────────────────────────────────────

/**
 * Prettier formatting options surfaced under the
 * `aspLanguageSupport.prettier.*` configuration namespace.
 *
 * HTML, CSS, and JavaScript formatting is delegated entirely to Prettier
 * (https://prettier.io). These settings map 1-to-1 to Prettier's own options.
 */
export interface PrettierSettings {
    printWidth:                number;
    tabWidth:                  number;
    useTabs:                   boolean;
    semi:                      boolean;
    singleQuote:               boolean;
    bracketSameLine:           boolean;
    arrowParens:               string;
    trailingComma:             string;
    endOfLine:                 string;
    htmlWhitespaceSensitivity: string;
}

export function getPrettierSettings(): PrettierSettings {
    const config = vscode.workspace.getConfiguration('aspLanguageSupport.prettier');
    return {
        printWidth:                config.get<number>('printWidth',                80),
        tabWidth:                  config.get<number>('tabWidth',                  2),
        useTabs:                   config.get<boolean>('useTabs',                  false),
        semi:                      config.get<boolean>('semi',                     true),
        singleQuote:               config.get<boolean>('singleQuote',              false),
        bracketSameLine:           config.get<boolean>('bracketSameLine',          false),
        arrowParens:               config.get<string>('arrowParens',               'always'),
        trailingComma:             config.get<string>('trailingComma',             'es5'),
        endOfLine:                 config.get<string>('endOfLine',                 'auto'),
        htmlWhitespaceSensitivity: config.get<string>('htmlWhitespaceSensitivity', 'css'),
    };
}

// ─── ASP block types ───────────────────────────────────────────────────────

// Where in the HTML structure an ASP block sits:
//   normal  – a statement block on its own line(s) → HTML comment placeholder
//   text    – a <%= … %> expression in page content → word placeholder
//   inline  – inside a quoted attribute value      → bare token placeholder
//   midtag  – between attributes, not quoted       → data- attribute placeholder
//   rawtext – inside a <script>/<style> body       → bare identifier placeholder
//             (an HTML-comment placeholder is legal JS/CSS and gets parsed by
//              Prettier — it would REORDER/corrupt the code — so raw-text blocks
//              use an identifier token Prettier leaves in place instead)
type AspBlockKind = 'normal' | 'text' | 'inline' | 'midtag' | 'rawtext';

interface AspBlock {
    code:       string;
    id:         string;
    lineNumber: number;
    kind:       AspBlockKind;
    /** The exact string emitted in place of the block, for kinds that need one. */
    token?:     string;
}

/** A tag kept out of Prettier's sight behind `<!--id-->` — see analyseHtmlStructure. */
interface HiddenTagPlaceholder {
    id:     string;
    text:   string;
    /** Levels shallower than where Prettier lays the placeholder out. */
    dedent: number;
}

/** `<%= … %>` — Response.Write in expression form, so its output is page text. */
function isAspExpression(block: string): boolean {
    const trimmed = block.trimStart();
    return trimmed.startsWith('<%=') || trimmed.startsWith('<% =');
}

/**
 * A word-shaped stand-in for a `<%= … %>` expression in page content.
 *
 * Two properties matter, and the HTML-comment placeholder used for statement
 * blocks has neither.
 *
 * It has to read as TEXT. Prettier treats a comment as a node that cannot share
 * a line with prose, so it breaks the line around it and then moves the
 * enclosing tag's `>` down to keep the rendered whitespace unchanged — which is
 * where `<span class="info-value"\n  ><!--ID-->\n  &mdash;` comes from. Measured
 * against Prettier directly, a bare word is laid out identically to the real
 * text it stands for, while the comment is not.
 *
 * It has to be the RIGHT LENGTH. Prettier measures the MASKED line, so a
 * 30-character placeholder standing in for `<%= txtbadge %>` reports a line as
 * twice its true width and breaks one that would have fitted. Padding the token
 * to the width of the block it replaces keeps printWidth honest.
 *
 * Widening the token until the page does not already contain it is the guard
 * prettier-plugin-jinja-template uses for its own `#~1~#` tokens: a short token
 * is only safe once it is known not to collide with real content.
 *
 * `collisions` comes from tokenCollisions, so the page is searched once for
 * every block rather than once per block.
 */
function paddedToken(prefix: string, index: number, width: number, collisions: Map<string, number>): string {
    // The trailing `E` terminates the number, so no token can be a prefix of
    // another once both are padded — `AspExpr1E…` never occurs inside
    // `AspExpr12E…`, which matters because restoring replaces by substring.
    const token = `${prefix}${index}E`;
    let pad = Math.max(0, width - token.length);
    // The page already holds this token followed by `longest` x's, so it is
    // only unique once it is padded past them.
    const longest = collisions.get(String(index));
    if (longest !== undefined && longest >= pad) { pad = longest + 1; }
    return token + 'x'.repeat(pad);
}

/**
 * For every index the page already spells out as `${prefix}${index}E`, the
 * longest run of `x` that follows it — what paddedToken needs to know to make
 * its token unique.
 */
function tokenCollisions(source: string, prefix: string): Map<string, number> {
    const longest = new Map<string, number>();
    const pattern = new RegExp(`${prefix}(\\d+)E(x*)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
        longest.set(m[1], Math.max(longest.get(m[1]) ?? -1, m[2].length));
    }
    return longest;
}

// Numbers the placeholders of one format, from 0 each time — see
// formatCompleteAspFile. Ids stay unique because they also carry a timestamp and
// a random part; the number is what goes into a token's width.
let _placeholderCounter = 0;

// Created the first time Prettier fails, then reused: making a new one each
// time left another "ASP Formatter Debug" entry in the Output list per failure.
let _debugChannel: vscode.OutputChannel | undefined;

export function disposeFormatterDebugChannel(): void {
    _debugChannel?.dispose();
    _debugChannel = undefined;
}

// A closing tag for a void element — `</br>`, `</img>` — which HTML has no
// such thing as.
const VOID_CLOSING_TAG_RE = new RegExp(`</(${[...VOID_ELEMENTS].join('|')})\\s*>`, 'gi');

// ─── JS event attribute masking ───────────────────────────────────────────

interface JsAttrMask {
    token: string;
    original: string; // the full attribute value text, quotes excluded
    quote: string;
}

// Matches any on* event attribute whose value contains at least one `(` — those
// are the ones Prettier treats as embedded JS and wraps onto multiple lines.
const JS_EVENT_ATTR_RE = /\b(on\w+)\s*=\s*("([^"]*\([^"]*)"|'([^']*\([^']*)')/gi;

/** Replaces inline JS event-handler values with opaque tokens so Prettier
 *  cannot see the parentheses and apply its JS-expression line-wrap logic.
 *  Returns the rewritten string and a map needed to undo the masking. */
function maskJsEventAttrs(code: string): { masked: string; masks: JsAttrMask[] } {
    const masks: JsAttrMask[] = [];
    const masked = code.replace(JS_EVENT_ATTR_RE, (_, attrName, _fullVal, dq, sq) => {
        const inner = dq ?? sq;
        const quote = dq !== undefined ? '"' : "'";
        const token = `JSEVT${_placeholderCounter++}_${Date.now().toString(36)}`;
        masks.push({ token, original: inner, quote });
        return `${attrName}=${quote}${token}${quote}`;
    });
    return { masked, masks };
}

/** Restores all JS event-handler values that were masked by maskJsEventAttrs. */
function restoreJsEventAttrs(code: string, masks: JsAttrMask[]): string {
    if (masks.length === 0) { return code; }
    const byToken = new Map(masks.map(mask => [mask.token, mask]));
    // One pass for every mask. Prettier may have changed the surrounding quote
    // style, so either is matched; the function replacement keeps `$`-sequences
    // in the original value (e.g. $&, $$) literal.
    //
    // Prettier formats an on* value as JavaScript, and a line too long for
    // printWidth gets its value moved onto a line of its own —
    // `onclick="\n  JSEVT4_x\n"`. Without the whitespace allowed here that token
    // was never restored, and the page's event handler was replaced by it.
    return code.replace(/["']\s*(JSEVT\d+_[0-9a-z]+)\s*["']/g, (whole, token: string) => {
        const mask = byToken.get(token);
        return mask ? `${mask.quote}${mask.original}${mask.quote}` : whole;
    });
}

// ─── Safety check ─────────────────────────────────────────────────────────

/**
 * Returns true if the source has unmatched <% or %> tags.
 * An unclosed <% would cause the masking regex to consume everything after it.
 *
 * Skips:
 *  - HTML comments  <!-- ... -->  entirely (ASP tags inside them are not real)
 *  - VBScript comment lines (first non-whitespace char is ') inside ASP blocks
 *  - %> inside string literals inside ASP blocks
 */
function hasUnclosedAspTags(code: string): boolean {
    let depth   = 0;
    let i       = 0;
    let inHtmlComment = false;

    while (i < code.length) {
        // ── HTML comment open  <!-- ──────────────────────────────────────────
        if (!inHtmlComment && depth === 0 &&
            code[i] === '<' && code.slice(i, i + 4) === '<!--') {
            inHtmlComment = true;
            i += 4;
            continue;
        }
        // ── HTML comment close  --> ──────────────────────────────────────────
        if (inHtmlComment) {
            if (code.slice(i, i + 3) === '-->') { inHtmlComment = false; i += 3; }
            else { i++; }
            continue;
        }

        // ── ASP open  <% ─────────────────────────────────────────────────────
        if (code[i] === '<' && code[i + 1] === '%') {
            depth++;
            i += 2;
            continue;
        }

        // ── Inside ASP block: scan line-by-line ──────────────────────────────
        if (depth > 0) {
            const lineEnd  = code.indexOf('\n', i);
            const lineText = lineEnd === -1 ? code.slice(i) : code.slice(i, lineEnd + 1);
            const end      = lineEnd === -1 ? code.length   : lineEnd + 1;

            // VBScript comment line — no %> on this line counts
            if (lineText.trimStart().startsWith("'")) {
                i = end;
                continue;
            }

            // Scan line for %> outside string literals
            let j = i, inStr = false, found = false;
            while (j < end) {
                if (code[j] === '"') {
                    if (inStr && j + 1 < end && code[j + 1] === '"') { j += 2; continue; }
                    inStr = !inStr; j++; continue;
                }
                if (!inStr && code[j] === '%' && j + 1 < code.length && code[j + 1] === '>') {
                    depth--;
                    if (depth < 0) { return true; }
                    j += 2; found = true; i = j; break;
                }
                j++;
            }
            if (!found) { i = end; }
            continue;
        }

        i++;
    }

    return depth !== 0;
}

// ─── ASP block classifier ─────────────────────────────────────────────────

/**
 * Decides whether an ASP block is inline (inside a quoted attribute value),
 * midtag (between unquoted attributes), or normal (free-standing), from
 * everything emitted before it.
 *
 * The emitted text is read forward, which is unambiguous: whether a quote opens
 * or closes an attribute value is known because the state is tracked as it goes.
 * It is fed a piece at a time as the page is masked, rather than rescanned from
 * the top for every block — which, with thousands of blocks, was most of the
 * time a format took.
 */
class EmittedContext {
    private inTag     = false;
    private attrQuote = '';
    private inComment = false;
    private dashes    = 0;
    /** The last character that is not a space or a tab. */
    private lastSolid = '';
    /**
     * A `<` whose meaning depends on text not emitted yet: it may be starting
     * `<!--`, and whether it opens a tag depends on the character after it.
     */
    private pending = '';

    feed(text: string): void {
        for (let i = 0; i < text.length; i++) { this.step(text[i]); }
    }

    kind(): AspBlockKind {
        // A `<` still waiting reads the way the end of the text does: with
        // nothing after it, it opens no tag; `<!` and `<!-` each open one.
        if (this.pending.length >= 2) { return 'midtag'; }
        if (this.attrQuote) { return 'inline'; }
        if (this.inTag)     { return 'midtag'; }
        return 'normal';
    }

    private step(ch: string): void {
        if (!this.pending) { this.consume(ch); return; }

        this.pending += ch;
        if (this.pending === '<!--') {
            this.pending   = '';
            this.lastSolid = '-';
            this.inComment = true;
            this.dashes    = 0;
            return;
        }
        if ('<!--'.startsWith(this.pending)) { return; }

        // Not a comment: the `<` opens a tag if a name character follows it,
        // and what came after it is read on from there.
        const held = this.pending;
        this.pending = '';
        if (/[a-zA-Z!?/]/.test(held[1])) { this.inTag = true; }
        for (let i = 1; i < held.length; i++) { this.step(held[i]); }
    }

    private consume(ch: string): void {
        const before = this.lastSolid;
        if (ch !== ' ' && ch !== '\t') { this.lastSolid = ch; }

        if (this.inComment) {
            if (ch === '>' && this.dashes >= 2) { this.inComment = false; }
            this.dashes = ch === '-' ? this.dashes + 1 : 0;
            return;
        }
        if (this.attrQuote) {
            if (ch === this.attrQuote) { this.attrQuote = ''; }
            return;
        }
        if (this.inTag) {
            if (ch === '>') { this.inTag = false; }
            // A quote opens a value only straight after `=` (spaces allowed).
            else if ((ch === '"' || ch === "'") && before === '=') { this.attrQuote = ch; }
            return;
        }
        if (ch === '<') { this.pending = '<'; }
    }
}

// ─── Raw-text (<script>/<style>) ASP handling ───────────────────────────────

/**
 * A JS/CSS-safe placeholder for an ASP block that lives inside a <script> or
 * <style> body. Must be a valid identifier in BOTH languages (lowercase so
 * Prettier's CSS printer can't rewrite its case) and derived deterministically
 * from the block id so masking, the survival check, and restore all agree.
 */
function rawTokenFor(id: string): string {
    return ('aspraw' + id).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Byte ranges [start, end) of every real <script>/<style> element BODY (between
 * the opening tag's `>` and the closing tag). Reuses the zone scanners so ASP
 * blocks, quoted attributes, and VBScript strings are handled the same way the
 * rest of the extension handles them.
 */
function computeRawTextRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const tag of ['<script', '<style'] as const) {
        const name = tag.slice(1); // 'script' | 'style'
        let from = 0;
        while (true) {
            const open = findNextRealTag(text, tag, from);
            if (open === -1) { break; }
            const tagEnd = findTagEnd(text, open);
            if (tagEnd === -1) { break; }
            const { index: close, length } = findClosingTag(text, name, tagEnd + 1);
            const bodyStart = tagEnd + 1;
            const bodyEnd   = close === -1 ? text.length : close;
            ranges.push([bodyStart, bodyEnd]);
            from = close === -1 ? text.length : close + length;
        }
    }
    return ranges;
}

function isInRawText(pos: number, ranges: Array<[number, number]>): boolean {
    return ranges.some(([s, e]) => pos >= s && pos < e);
}

// ─── Implied table end-tag normaliser ───────────────────────────────────────

/**
 * Classic ASP markup very often omits the optional </td> </tr> </th> </thead>
 * </tbody> </tfoot> end tags. Prettier's HTML parser does not apply the HTML
 * implied-end-tag rules for these, so a following <tr> is nested inside the
 * still-open <td> instead of starting a new row. This pass inserts the implied
 * closers (respecting nested <table>s, which act as a barrier) so Prettier
 * receives well-formed table structure.
 *
 * Only the table family is handled — the case that actually breaks in ASP. HTML
 * comments are skipped opaquely, so masked ASP placeholder comments are untouched,
 * and the pass is a no-op on markup that already has explicit end tags.
 */
export function insertImpliedTableEndTags(html: string): string {
    const CLOSEABLE = new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot']);
    const stack: string[] = [];
    let out = '';
    let i = 0;
    const n = html.length;

    // Emit </top> while the top of the stack should be implicitly closed. Never
    // pops past a <table> (a nested table is a barrier for cell/row closing).
    const closeWhile = (shouldClose: (top: string) => boolean): void => {
        while (stack.length && stack[stack.length - 1] !== 'table'
               && shouldClose(stack[stack.length - 1])) {
            out += '</' + stack.pop() + '>';
        }
    };

    while (i < n) {
        // HTML comment (incl. masked ASP placeholder comments) — opaque.
        if (html.startsWith('<!--', i)) {
            const end  = html.indexOf('-->', i + 4);
            const stop = end === -1 ? n : end + 3;
            out += html.slice(i, stop);
            i = stop;
            continue;
        }

        // A tag: <name …>, </name>, or <name …/>. (<%…%> is already masked away.)
        if (html[i] === '<' && /[a-zA-Z/]/.test(html[i + 1] ?? '')) {
            let j = i + 1;
            let quote = '';
            while (j < n) {
                const c = html[j];
                if (quote)                    { if (c === quote) { quote = ''; } j++; continue; }
                if (c === '"' || c === "'")   { quote = c; j++; continue; }
                if (c === '>')                { j++; break; }
                j++;
            }
            const tag       = html.slice(i, j);
            const isEnd     = tag[1] === '/';
            const selfClose = /\/\s*>$/.test(tag);
            const name      = (tag.match(/^<\/?\s*([a-zA-Z][\w:-]*)/)?.[1] ?? '').toLowerCase();

            // Insert implied closers BEFORE emitting this tag.
            if (!isEnd) {
                if (name === 'td' || name === 'th') {
                    closeWhile(t => t === 'td' || t === 'th');
                } else if (name === 'tr') {
                    closeWhile(t => t === 'td' || t === 'th' || t === 'tr');
                } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
                    closeWhile(t => CLOSEABLE.has(t));
                }
            } else {
                if (name === 'tr') {
                    closeWhile(t => t === 'td' || t === 'th');
                } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
                    closeWhile(t => t === 'td' || t === 'th' || t === 'tr');
                } else if (name === 'table') {
                    closeWhile(t => CLOSEABLE.has(t));
                }
            }

            out += tag;

            // Track table-family nesting.
            if (isEnd) {
                if (name === 'table') {
                    if (stack[stack.length - 1] === 'table') { stack.pop(); }
                } else if (CLOSEABLE.has(name)) {
                    const idx = stack.lastIndexOf(name);
                    if (idx !== -1) { stack.length = idx; }
                }
            } else if (!selfClose && (name === 'table' || CLOSEABLE.has(name))) {
                stack.push(name);
            }
            i = j;
            continue;
        }

        out += html[i];
        i++;
    }
    return out;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * True when `before` — the text from the start of its line up to a placeholder —
 * holds real content, so the block will have to be moved onto lines of its own.
 *
 * A placeholder sitting inside an unclosed quote is an attribute value, not tag
 * content — breaking the line there would split the tag open — so it does not
 * count however much text precedes it.
 */
function isInlinePlaced(before: string): boolean {
    if (before.trim().length === 0) { return false; }

    let quote: string | null = null;
    for (const ch of before) {
        if (!quote && (ch === '"' || ch === "'")) { quote = ch; }
        else if (quote && ch === quote)           { quote = null; }
    }
    return quote === null;
}

/**
 * A string built front to back, with the few edits the restore makes to its
 * end. Kept as pieces so that neither appending nor reading the current line
 * copies everything built so far — which, once per block, was quadratic.
 */
class TextBuilder {
    private readonly pieces: string[] = [];

    push(text: string): void {
        if (text) { this.pieces.push(text); }
    }

    /** The text after the last newline, and whether a newline comes before it. */
    currentLine(): { text: string; afterNewline: boolean } {
        let text = '';
        for (let i = this.pieces.length - 1; i >= 0; i--) {
            const piece = this.pieces[i];
            const nl = piece.lastIndexOf('\n');
            if (nl !== -1) { return { text: piece.slice(nl + 1) + text, afterNewline: true }; }
            text = piece + text;
        }
        return { text, afterNewline: false };
    }

    /** Removes the last `count` characters. */
    dropEnd(count: number): void {
        while (count > 0 && this.pieces.length > 0) {
            const last = this.pieces[this.pieces.length - 1];
            if (last.length <= count) { count -= last.length; this.pieces.pop(); }
            else { this.pieces[this.pieces.length - 1] = last.slice(0, last.length - count); count = 0; }
        }
    }

    /** Removes characters from the end for as long as `test` holds. */
    dropEndWhile(test: (ch: string) => boolean): void {
        while (this.pieces.length > 0) {
            const last = this.pieces[this.pieces.length - 1];
            let keep = last.length;
            while (keep > 0 && test(last[keep - 1])) { keep--; }
            if (keep > 0) { this.pieces[this.pieces.length - 1] = last.slice(0, keep); return; }
            this.pieces.pop();
        }
    }

    toString(): string { return this.pieces.join(''); }
}

const isBlank      = (ch: string) => ch === ' ' || ch === '\t';
const isWhitespace = (ch: string) => /\s/.test(ch);

/** Leading spaces and tabs of `line`. */
function leadingBlanks(line: string): string {
    let i = 0;
    while (i < line.length && isBlank(line[i])) { i++; }
    return line.slice(0, i);
}

/** How many spaces and tabs `line` ends with. */
function trailingBlankCount(line: string): number {
    let i = line.length;
    while (i > 0 && isBlank(line[i - 1])) { i--; }
    return line.length - i;
}

/**
 * Where each needle first occurs in `text`, -1 when it does not. The needles
 * are placeholders, which come back from Prettier in the order they went in,
 * so each search starts where the last one ended; one that is not found there
 * is looked for from the top, so the answers are the same as a fresh search.
 */
function findInOrder(text: string, needles: readonly string[]): number[] {
    let from = 0;
    return needles.map(needle => {
        let at = text.indexOf(needle, from);
        if (at === -1) { at = text.indexOf(needle); }
        if (at !== -1) { from = at + needle.length; }
        return at;
    });
}

export async function formatCompleteAspFile(code: string): Promise<string> {
    // A token's number is part of its length, and Prettier lays a line out by
    // its length. Counting on across the whole session meant the same page
    // wrapped differently once enough formats had gone before it — a page that
    // no longer settled, and format-on-save that moved lines back and forth.
    // Every placeholder is allocated before the first await, so a format that
    // starts while another awaits Prettier cannot disturb it.
    _placeholderCounter = 0;

    if (hasUnclosedAspTags(code)) {
        vscode.window.showWarningMessage(
            'Formatting skipped — unclosed <% or stray %> detected. Fix the ASP tag mismatch first.'
        );
        return code;
    }

    const aspSettings      = getAspSettings();
    const prettierSettings = getPrettierSettings();

    // ── Step 1: Mask JS event-handler attribute values ───────────────────────
    // Must happen BEFORE ASP masking so values like onclick="doA('<%= val %>'); doB()"
    // are captured whole — including embedded ASP expressions — as one opaque token.
    const { masked: jsPreMasked, masks: jsAttrMasks } = maskJsEventAttrs(code);

    // <script>/<style> body ranges — ASP blocks inside them need a JS/CSS-safe
    // identifier placeholder, not an HTML comment (which Prettier would parse as
    // a JS/CSS comment and reorder around, corrupting the code).
    const rawRanges = computeRawTextRanges(jsPreMasked);

    // ── Step 2: Mask all ASP blocks ──────────────────────────────────────────
    // Each ASP block is replaced with a placeholder that Prettier will treat as
    // valid HTML, preserving its position in the output.
    //
    // Everything below carries its state forward — the context of the text
    // emitted so far, the current line, the line number — instead of asking the
    // whole page again for every block.

    const aspBlocks: AspBlock[] = [];
    const masked    = new TextBuilder();
    const context   = new EmittedContext();

    // Tags Prettier must not see: one branch's copy of a tag another branch of
    // the same If opens or closes, or a tag whose partner VBScript writes. Read
    // top to bottom they look unbalanced, and Prettier re-nests the page around
    // them or appends a closing tag of its own. Each is hidden behind a comment
    // and put back afterwards, the indent it belongs at included.
    const hidden = analyseHtmlStructure(jsPreMasked).hidden;
    const hiddenTags: HiddenTagPlaceholder[] = [];
    let   nextHidden = 0;

    // The current line of the masked text: its leading blanks, and its trailing
    // run of blanks (the whole line while it is nothing but blanks).
    let lineLeading     = '';
    let lineHasContent  = false;
    let lineTrailing    = '';

    const emit = (text: string): void => {
        if (!text) { return; }
        masked.push(text);
        context.feed(text);

        const nl   = text.lastIndexOf('\n');
        const rest = nl === -1 ? text : text.slice(nl + 1);
        if (nl !== -1) { lineLeading = ''; lineHasContent = false; lineTrailing = ''; }

        if (!lineHasContent) {
            const blanks = leadingBlanks(rest);
            lineLeading += blanks;
            lineHasContent = blanks.length < rest.length;
        }
        let end = rest.length;
        while (end > 0 && isBlank(rest[end - 1])) { end--; }
        lineTrailing = end === 0 ? lineTrailing + rest : rest.slice(end);
    };

    const collisions = {
        AspExpr: tokenCollisions(code, 'AspExpr'),
        AspAttr: tokenCollisions(code, 'AspAttr'),
        aspmid:  tokenCollisions(code, 'aspmid'),
    };

    let lineNumber = 0;
    let countedTo  = 0;
    let pos        = 0;

    // The next HTML comment and ASP block at or after `pos`, each searched for
    // again only once `pos` has passed it — a page with no comments would
    // otherwise be searched to its end once per block.
    let comment = -2;
    let block   = -2;

    while (pos < jsPreMasked.length) {
        // Page text up to the next HTML comment, ASP block or hidden tag goes
        // through as is.
        if (comment !== -1 && comment < pos) { comment = jsPreMasked.indexOf('<!--', pos); }
        if (block   !== -1 && block   < pos) { block   = jsPreMasked.indexOf('<%', pos); }
        while (nextHidden < hidden.length && hidden[nextHidden].start < pos) { nextHidden++; }
        const tag  = nextHidden < hidden.length ? hidden[nextHidden].start : -1;
        const next = [comment, block, tag].filter(at => at !== -1).reduce((a, b) => Math.min(a, b), Infinity);
        if (next === Infinity) { emit(jsPreMasked.slice(pos)); break; }
        emit(jsPreMasked.slice(pos, next));
        pos = next;

        // ── A hidden tag ───────────────────────────────────────────────────
        if (next === tag) {
            const { end, dedent } = hidden[nextHidden++];
            const id = `ASPTAG${hiddenTags.length}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
            hiddenTags.push({ id, text: jsPreMasked.slice(pos, end), dedent });
            emit(`<!--${id}-->`);
            pos = end;
            continue;
        }

        // ── HTML comment: copied through its first `-->` ───────────────────
        if (next === comment) {
            // Searched from the character after the `<`, as it always was — so
            // `<!-->` is a whole comment.
            const close = jsPreMasked.indexOf('-->', pos + 1);
            const end   = close === -1 ? jsPreMasked.length : close + 1;
            emit(jsPreMasked.slice(pos, end));
            pos = end;
            continue;
        }

        // ── ASP block  <% ... %> ──────────────────────────────────────────
        // Leading horizontal whitespace on this line, for indent tracking.
        const leadingWS = lineLeading;

        // Find the matching %> (using the same comment-aware logic so a '
        // comment line inside the block can't close it prematurely)
        let end = pos + 2;
        while (end < jsPreMasked.length) {
            if (jsPreMasked[end] === '%' && jsPreMasked[end + 1] === '>') {
                // Check whether this %> is on a VBScript comment line.
                // A VBScript comment starts with ' as the first non-whitespace
                // character INSIDE the ASP block — not just anywhere on the
                // HTML line.  We scan from the later of: the start of the
                // current line, or the opening <% tag itself, so that a JS
                // single-quote that precedes the ASP block on the same line
                // (e.g.  '<%= code %>'  ) cannot trip the comment check.
                const lineBegin      = jsPreMasked.lastIndexOf('\n', end - 1) + 1;
                const aspContentStart = pos + 2; // first char after <%
                const scanFrom       = Math.max(lineBegin, aspContentStart);
                const lineUpToClose  = jsPreMasked.slice(scanFrom, end).trimStart();
                if (!lineUpToClose.startsWith("'")) {
                    end += 2; // include the %>
                    break;
                }
            }
            end++;
        }

        const aspBlock = jsPreMasked.slice(pos, end);
        // A block inside a <script>/<style> body is raw-text; otherwise decide
        // from the surrounding HTML whether it is inline/midtag/normal.
        let   kind     = isInRawText(pos, rawRanges) ? 'rawtext' : context.kind();

        for (let i = countedTo; i < pos; i++) { if (jsPreMasked[i] === '\n') { lineNumber++; } }
        countedTo = pos;

        const index = _placeholderCounter++;
        const id    = `ASPPH${index}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

        // A `<%= … %>` in page content is an expression whose output is part
        // of the text around it, so it is masked as text rather than as a
        // comment — see paddedToken. This applies wherever the expression sits,
        // not only where it shares a line, so that a page already broken apart
        // by the old placeholder is pulled back together the next time it is
        // formatted.
        if (kind === 'normal' && isAspExpression(aspBlock)) { kind = 'text'; }

        // `midtag` is emitted as `name="1"`, four characters more than the
        // name itself, so the name is padded to that much less.
        const token =
            kind === 'text'   ? paddedToken('AspExpr', index, aspBlock.length,     collisions.AspExpr) :
            kind === 'inline' ? paddedToken('AspAttr', index, aspBlock.length,     collisions.AspAttr) :
            kind === 'midtag' ? paddedToken('aspmid',  index, aspBlock.length - 4, collisions.aspmid)  :
            undefined;

        aspBlocks.push({ code: aspBlock, id, lineNumber, kind, token });

        // Replace leading whitespace + block with the placeholder
        // (strip the leadingWS we already emitted so the placeholder
        //  takes its place cleanly)
        if (leadingWS && lineTrailing.endsWith(leadingWS)) {
            masked.dropEnd(leadingWS.length);
            lineTrailing = lineTrailing.slice(0, lineTrailing.length - leadingWS.length);
            if (!lineHasContent) { lineLeading = lineLeading.slice(0, lineLeading.length - leadingWS.length); }
        }

        switch (kind) {
            case 'text':    emit(token!);           break;
            case 'inline':  emit(token!);           break;
            case 'midtag':  emit(`${token}="1"`);   break;
            case 'rawtext': emit(rawTokenFor(id));  break;
            default:        emit(`<!--${id}-->`);   break;
        }
        pos = end;
    }

    let maskedCode = masked.toString();

    // Strip closing tags on void elements (</br>, </input>, …) that Prettier
    // hard-fails on. Done AFTER masking so a void closer that lives inside a
    // VBScript string or ASP block (e.g. Response.Write "</br>") is already a
    // placeholder here and is preserved — the previous raw-text strip silently
    // deleted it. Real HTML void closers are still removed; the structure
    // diagnostic continues to flag them for the user to fix.
    maskedCode = maskedCode.replace(VOID_CLOSING_TAG_RE, '');

    // Insert implied </td> </tr> … closers so Prettier doesn't mis-nest tables
    // whose optional end tags were omitted (very common in Classic ASP).
    maskedCode = insertImpliedTableEndTags(maskedCode);

    // ── Step 3: Run Prettier on the masked HTML ──────────────────────────────

    const prettierOptions: prettier.Options = {
        parser:                    'html',
        printWidth:                prettierSettings.printWidth,
        tabWidth:                  prettierSettings.tabWidth,
        useTabs:                   prettierSettings.useTabs,
        semi:                      prettierSettings.semi,
        singleQuote:               prettierSettings.singleQuote,
        bracketSameLine:           prettierSettings.bracketSameLine,
        arrowParens:               prettierSettings.arrowParens               as any,
        trailingComma:             prettierSettings.trailingComma             as any,
        endOfLine:                 prettierSettings.endOfLine                 as any,
        htmlWhitespaceSensitivity: prettierSettings.htmlWhitespaceSensitivity as any,
    };

    // Loaded on the first format rather than when the extension starts: nothing
    // else needs it, and loading it added ~40 ms to every window's startup.
    const { format } = require('prettier') as typeof prettier;

    let prettifiedCode: string;
    try {
        prettifiedCode = await vscode.window.withProgress(
            {
                location:  vscode.ProgressLocation.Notification,
                title:     'Classic ASP: Formatting…',
                cancellable: false,
            },
            () => format(maskedCode, prettierOptions)
        );
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const lineMatch = msg.match(/\((\d+):(\d+)\)/);
        const location  = lineMatch ? ` (line ${lineMatch[1]}, col ${lineMatch[2]})` : '';

        // ── Debug: log the masked code so we can see what Prettier choked on ──
        const channel = (_debugChannel ??= vscode.window.createOutputChannel('ASP Formatter Debug'));
        channel.clear();
        channel.appendLine('=== Prettier parse error' + location + ' ===');
        channel.appendLine('Error: ' + msg);
        channel.appendLine('');
        channel.appendLine('=== Masked code sent to Prettier ===');
        channel.appendLine(maskedCode);
        channel.appendLine('');
        channel.appendLine('=== ASP blocks classified ===');
        for (const b of aspBlocks) {
            channel.appendLine(`  line ${b.lineNumber + 1}  kind=${b.kind}  ${b.code.slice(0, 60).replace(/\n/g, '\\n')}`);
        }
        channel.show(true);

        vscode.window.showWarningMessage(
            `Formatting skipped — Prettier could not parse the HTML${location}. ` +
            `Check the "ASP Formatter Debug" output channel to see the masked code.`
        );
        return code;
    }

    const commentFor = (block: AspBlock) => `<!--${block.id}-->`;
    const normalBlocks = aspBlocks.filter(block => block.kind === 'normal');

    // ── Step 3b: Lay the page out the way it is going to end up ─────────────
    // A statement block that Prettier left inline — `<td><!--ID-->y</td>` — is
    // about to be moved onto lines of its own during the restore. Its indent
    // was read from the whitespace immediately before the placeholder, which is
    // empty in exactly that case, so the block landed at column 0 and only
    // reached its real column on a SECOND format, once the page already had it
    // standalone. Every enclosing element behaved that way: td, div, p and span
    // all took two passes.
    //
    // Rather than predict where Prettier would have put the block, put it there
    // and ask. Splitting the placeholder onto its own line and formatting again
    // yields, in one pass, exactly what the second pass used to produce — the
    // indentation is Prettier's either way, just computed against the layout
    // that is actually going to be written out.
    //
    // The second run only happens when there is something to move.
    if (!aspSettings.aspTagsOnSameLine) {
        // A hidden tag is a structural element — a div, a form, a table — so it
        // gets a line of its own too, rather than being left after a `%>`.
        const placeholders = [
            ...normalBlocks.map(commentFor),
            ...hiddenTags.map(tag => `<!--${tag.id}-->`),
        ];
        const at = [
            ...findInOrder(prettifiedCode, normalBlocks.map(commentFor)),
            ...findInOrder(prettifiedCode, hiddenTags.map(tag => `<!--${tag.id}-->`)),
        ];
        const toSplit = placeholders
            .map((placeholder, i) => ({ placeholder, at: at[i] }))
            .filter(({ at }) => at !== -1
                && isInlinePlaced(prettifiedCode.slice(prettifiedCode.lastIndexOf('\n', at - 1) + 1, at)))
            .sort((a, b) => a.at - b.at);

        if (toSplit.length > 0) {
            const respaced = new TextBuilder();
            let scan = 0;
            for (const { placeholder, at } of toSplit) {
                respaced.push(prettifiedCode.slice(scan, at));
                scan = at;

                // Re-asked against the text as it NOW stands, not against the
                // list built before the loop. Two adjacent blocks —
                // `<% End If %><% End If %>` — are both inline-placed to begin
                // with, but splitting the first already pushes the second onto a
                // line of its own, and prepending a second newline to it leaves
                // a blank line behind.
                if (!isInlinePlaced(respaced.currentLine().text)) { continue; }

                // Add only the newlines that are missing. The placeholder
                // already ends its line whenever nothing follows it, and a
                // second newline there would leave a blank line for Prettier
                // to preserve — which is the blank line this formatter was
                // just taught not to produce.
                const afterIdx  = at + placeholder.length;
                const lineEnd   = prettifiedCode.indexOf('\n', afterIdx);
                const afterText = lineEnd === -1
                    ? prettifiedCode.slice(afterIdx)
                    : prettifiedCode.slice(afterIdx, lineEnd);
                const trailer   = afterText.trim().length > 0 ? '\n' : '';

                respaced.push('\n' + placeholder + trailer);
                scan = afterIdx;
            }
            respaced.push(prettifiedCode.slice(scan));

            try {
                prettifiedCode = await format(respaced.toString(), prettierOptions);
            } catch {
                // Keep the first result: a layout that needs a second format is
                // far better than refusing to format at all.
            }
        }
    }

    // ── Step 3c: Verify all placeholders survived Prettier ──────────────────

    const needles = aspBlocks.map(block =>
        block.kind === 'rawtext' ? rawTokenFor(block.id) :
        block.kind === 'normal'  ? block.id              :
        block.token!);
    const found = findInOrder(prettifiedCode, needles);

    for (let i = 0; i < aspBlocks.length; i++) {
        if (found[i] === -1) {
            vscode.window.showWarningMessage(
                `Formatting skipped — an ASP block on line ${aspBlocks[i].lineNumber + 1} was removed by Prettier. ` +
                `This usually happens when a <% %> block is in an unexpected position inside an HTML tag.`
            );
            return code;
        }
    }

    const hiddenAt = findInOrder(prettifiedCode, hiddenTags.map(tag => `<!--${tag.id}-->`));
    if (hiddenAt.includes(-1)) {
        vscode.window.showWarningMessage(
            'Formatting skipped — Prettier removed a tag that an If, a Select Case or a Response.Write ' +
            'opens or closes. The page was left as it was.'
        );
        return code;
    }

    // Where each block's placeholder is — for a statement block, the whole
    // `<!--ID-->` comment rather than the id it was verified by.
    const placeholderAt = aspBlocks.map((block, i) => {
        if (block.kind !== 'normal') { return found[i]; }
        const comment = commentFor(block);
        return prettifiedCode.startsWith(comment, found[i] - 4) ? found[i] - 4 : prettifiedCode.indexOf(comment);
    });

    // ── Step 4: Format each ASP block's VBScript content ────────────────────
    // Process blocks sequentially so each normal block can thread its ending
    // indent level into the next, enabling cross-block continuity.

    const formattedBlocks:  string[] = [];
    const blockStartLevels: number[] = [];
    const blockHtmlIndents: string[] = [];
    let   currentIndentLevel         = 0;

    for (let i = 0; i < aspBlocks.length; i++) {
        const block = aspBlocks[i];
        if (block.kind !== 'normal') {
            // Format but don't change the tracked level, and keep <% %> on one
            // line whatever aspTagsOnSameLine says.
            //
            // Every kind other than `normal` sits inside something a line break
            // would break open: a JS or CSS statement (rawtext), an attribute
            // value (inline), the gap between two attributes (midtag), or a run
            // of page text (text). Only rawtext was given this treatment, so a
            // statement between attributes was expanded to
            //
            //     <input
            //       type="text" <%
            //     If sel Then
            //     %>
            //       checked <%
            //
            // — the VBScript dedented to column 0 and the tag torn apart around it.
            const blockSettings = { ...aspSettings, aspTagsOnSameLine: true };
            const result = formatSingleAspBlock(block.code, blockSettings, '', currentIndentLevel);
            formattedBlocks.push(result.formatted);
            blockStartLevels.push(-1);
            blockHtmlIndents.push('');
            continue;
        }

        // For normal blocks, capture the HTML indent Prettier placed before
        // the placeholder comment so the VBScript formatter can use it when
        // the delimiters go to column 0.
        const at = placeholderAt[i];
        let start = at;
        while (start > 0 && isBlank(prettifiedCode[start - 1])) { start--; }
        const htmlIndent = at === -1 ? '' : prettifiedCode.slice(start, at);

        blockStartLevels.push(currentIndentLevel);
        blockHtmlIndents.push(htmlIndent);

        const result = formatSingleAspBlock(block.code, aspSettings, htmlIndent, currentIndentLevel);
        formattedBlocks.push(result.formatted);
        currentIndentLevel = result.endLevel;
    }

    // ── Step 4b: Compute the shared tag-column for each linked group ─────────
    // With the delimiters at the HTML indent, consecutive normal blocks that are
    // part of the same VBScript flow (startLevel > 0 for all but the first)
    // share one logical script. Their <% / %> delimiters should all sit at the
    // same column — the HTML indent of the shallowest (first) block in the group
    // — so the tags form a consistent left margin regardless of HTML nesting
    // depth. A new group starts whenever a normal block has startLevel === 0.

    const blockTagIndents: string[] = new Array(aspBlocks.length).fill('');

    if (!delimitersAtColumnZero(aspSettings)) {
        let groupTagIndent = '';
        for (let i = 0; i < aspBlocks.length; i++) {
            if (aspBlocks[i].kind !== 'normal') continue;
            if (blockStartLevels[i] === 0) {
                // New group — this block's HTML indent becomes the shared tag column.
                groupTagIndent = blockHtmlIndents[i];
            }
            blockTagIndents[i] = groupTagIndent;
        }
    }

    // ── Step 5: Restore formatted ASP blocks into Prettier's output ─────────
    // One pass, front to back. Each block is restored against the text as
    // restored so far — the line it now sits on includes any block restored
    // before it on that line — exactly as the old one-replace-per-block loop saw
    // it, without rebuilding the whole page once per block.

    type RestoreItem =
        | { block: AspBlock; i: number; at: number }
        | { tag: HiddenTagPlaceholder; at: number };

    const order: RestoreItem[] = [
        ...aspBlocks
            .map((block, i) => ({ block, i, at: placeholderAt[i] }))
            .filter(({ at }) => at !== -1),
        ...hiddenTags.map((tag, t) => ({ tag, at: hiddenAt[t] })),
    ].sort((a, b) => a.at - b.at);

    const indentUnit = prettierSettings.useTabs ? '\t' : ' '.repeat(prettierSettings.tabWidth);
    const restored = new TextBuilder();
    let scan = 0;

    for (const item of order) {
        if ('tag' in item) {
            restored.push(prettifiedCode.slice(scan, item.at));
            scan = item.at + `<!--${item.tag.id}-->`.length;

            // On a line of its own, the tag goes at the indent it belongs at —
            // not the one Prettier gave its placeholder, inside the element the
            // first branch opened.
            const line = restored.currentLine();
            if (!line.text.split('').every(isBlank)) { restored.push(item.tag.text); continue; }

            let indent = line.text;
            if (item.tag.dedent > 0) {
                indent = indent.slice(0, Math.max(0, indent.length - indentUnit.length * item.tag.dedent));
            } else if (item.tag.dedent < 0) {
                indent += indentUnit.repeat(-item.tag.dedent);
            }
            restored.dropEnd(line.text.length);
            restored.push(indent + item.tag.text);
            continue;
        }

        const { block, i, at } = item;
        const formatted = formattedBlocks[i];
        restored.push(prettifiedCode.slice(scan, at));

        switch (block.kind) {

            case 'text': {
                // A word placeholder is laid out as the surrounding prose, so
                // wherever Prettier put it is where the expression belongs —
                // including on a line it wrapped onto. A straight swap is all
                // that is needed, and nothing may be done to the whitespace
                // around it: in `<span><%= a %></span>` a single space either
                // side is rendered text.
                restored.push(formatted);
                scan = at + block.token!.length;
                break;
            }

            case 'rawtext': {
                // Identifier placeholder inside <script>/<style>; Prettier kept it
                // in place, so a straight swap restores the original position.
                restored.push(formatted.trim());
                scan = at + rawTokenFor(block.id).length;
                break;
            }

            case 'inline': {
                const isExpression = block.code.trimStart().startsWith('<%=') ||
                                     block.code.trimStart().startsWith('<% =');
                scan = at + block.token!.length;

                if (isExpression) {
                    // <%= ... %> is an inline expression — part of the HTML content.
                    // Restore it exactly in place without touching any surrounding
                    // whitespace, and keep it on one line: breaking it would
                    // introduce unwanted whitespace into the rendered HTML.
                    restored.push(formatted);
                } else {
                    // <% ... %> is a code block inside an attribute value.
                    // Prettier may have moved the token onto its own line — strip
                    // any newline + whitespace it injected before/after the token
                    // so the result doesn't break the attribute value open.
                    const line = restored.currentLine();
                    if (line.afterNewline && line.text.split('').every(isBlank)) {
                        restored.dropEnd(line.text.length + 1);
                    }
                    restored.push(formatted);
                    const after = /[ \t]*\n/y;
                    after.lastIndex = scan;
                    const m = after.exec(prettifiedCode);
                    if (m) { scan += m[0].length; }
                }
                break;
            }

            case 'midtag': {
                // Prettier may have normalised quotes/spacing around the attribute.
                const value = /\s*=\s*["']1["']/y;
                value.lastIndex = at + block.token!.length;
                const m = value.exec(prettifiedCode);
                if (!m) {
                    restored.push(block.token!);
                    scan = at + block.token!.length;
                    break;
                }
                restored.dropEndWhile(isWhitespace);
                restored.push(` ${formatted}`);
                scan = at + block.token!.length + m[0].length;
                break;
            }

            default: {
                const placeholder      = commentFor(block);
                const afterIdx         = at + placeholder.length;
                const textBeforeOnLine = restored.currentLine().text;
                scan = afterIdx;

                // A block is "inline placed" when Prettier left non-whitespace
                // content before the placeholder on the same line.
                // EXCEPTION: if that content contains an unclosed quote the
                // placeholder is sitting inside an attribute value
                // (e.g. value="<!--ID-->" or onclick="...<!--ID-->...").
                // In that case we must restore inline — no newlines inserted —
                // because breaking the attribute value open corrupts the HTML.
                const hasContentBefore = textBeforeOnLine.trimStart().length > 0;
                const isInsideQuote    = hasContentBefore && (() => {
                    let inQ: string | null = null;
                    for (const ch of textBeforeOnLine) {
                        if (!inQ && (ch === '"' || ch === "'")) { inQ = ch; }
                        else if (inQ && ch === inQ)             { inQ = null; }
                    }
                    return inQ !== null; // still inside a quote → unclosed
                })();
                const isExpression     = block.code.trimStart().startsWith('<%=') ||
                                         block.code.trimStart().startsWith('<% =');
                const isInlinePlacedHere = hasContentBefore && !isInsideQuote && !isExpression;

                // Every restore below replaces the spaces and tabs in front of
                // the placeholder along with it.
                const blanksBefore = textBeforeOnLine.slice(textBeforeOnLine.length - trailingBlankCount(textBeforeOnLine));
                restored.dropEndWhile(isBlank);

                if (isInlinePlacedHere && !aspSettings.aspTagsOnSameLine) {
                    // Block sits inline in tag text content (e.g. <td><!--ID--></td>).
                    // Expand it onto its own indented lines.
                    const baseIndent = leadingBlanks(textBeforeOnLine);

                    // With the delimiters at the HTML indent, use the group's
                    // shared tag column so this block's tags align with all
                    // sibling blocks in the same VBScript group.
                    const inlineTagIndent = delimitersAtColumnZero(aspSettings)
                        ? ''
                        : blockTagIndents[i];

                    const indentedBlock = formatted
                        .split('\n')
                        .map(line => {
                            if (!line.trim()) return line;
                            const t = line.trim();
                            if (t === '<%' || t === '%>') return inlineTagIndent + t;
                            return delimitersAtColumnZero(aspSettings)
                                ? line
                                : blockTagIndents[i] + line;
                        })
                        .join('\n');

                    // Start a new line AFTER the block only when something
                    // else is still on this one. When the placeholder ended
                    // its line, that line's own newline already separates the
                    // block from what follows, and adding another leaves a
                    // blank line behind: permanent in the middle of a file,
                    // and stripped by the NEXT format at end of file, so the
                    // file never converges.
                    const lineEnd    = prettifiedCode.indexOf('\n', afterIdx);
                    const restOfLine = lineEnd === -1
                        ? prettifiedCode.slice(afterIdx)
                        : prettifiedCode.slice(afterIdx, lineEnd);
                    const endsTheLine = restOfLine.trim().length === 0;

                    if (endsTheLine) {
                        // Trailing spaces are swallowed too, so the %> line is
                        // not left with whitespace the next pass would remove.
                        while (scan < prettifiedCode.length && isBlank(prettifiedCode[scan])) { scan++; }
                        restored.push(`\n${indentedBlock}`);
                    } else {
                        restored.push(`\n${indentedBlock}\n${baseIndent}`);
                    }
                    break;
                }

                // Expression sitting inline in tag text content (e.g. <td><%= val %></td>)
                // — restore it exactly as-is with no indentation applied.
                if (isExpression && hasContentBefore && !isInsideQuote) {
                    restored.push(formatted.trim());
                    break;
                }

                // Block is either standalone on its own line, or inside a
                // quoted attribute value — restore with correct tag indentation.
                //
                // With the delimiters at column 0, aspFormatter already adds the
                // HTML depth to the content indent, so the content is complete
                // and the tags go to column 0. With the delimiters at the HTML
                // indent, the group's shared tag column (the HTML indent of the
                // first, shallowest block of the group) goes in front of both,
                // so every <% / %> of the group aligns at the same column.
                const tagIndent = delimitersAtColumnZero(aspSettings)
                    ? ''                   // tags at col 0; content has full indent
                    : blockTagIndents[i];  // shared group column

                const indentedBlock = formatted
                    .split('\n')
                    .map(line => {
                        if (!line.trim()) return line;
                        const t = line.trim();
                        if (t === '<%' || t === '%>') return tagIndent + t;
                        return delimitersAtColumnZero(aspSettings)
                            ? line
                            : blockTagIndents[i] + line;
                    })
                    .join('\n');

                // After other content — where aspTagsOnSameLine leaves it — the
                // block stays where Prettier put it, with the space it had in
                // front. The group's tag column belongs at the start of a line:
                // mid-line it was a run of spaces, which the next format broke
                // the line at.
                if (hasContentBefore && !isInsideQuote) {
                    restored.push(blanksBefore + indentedBlock.slice(leadingBlanks(indentedBlock).length));
                    break;
                }

                restored.push(indentedBlock);
                break;
            }
        }
    }
    restored.push(prettifiedCode.slice(scan));

    // ── Step 5b: Restore JS event-handler attribute values ──────────────────
    // Must happen after ASP blocks are restored so token text is never
    // accidentally matched inside a reconstructed ASP expression.
    let restoredCode = restoreJsEventAttrs(restored.toString(), jsAttrMasks);

    // ── Step 6: Fix broken whitespace-sensitive tags (<textarea>, <pre>) ─────
    // When the expression inside is long, Prettier can wrap the closing `>`
    // of the opening tag onto its own line, and separately break the closing
    // tag:
    //
    //   <textarea ...attrs...>
    //   <%= val %></textarea
    //                       >
    //
    // This is invalid for whitespace-sensitive tags because any whitespace
    // between `>` and the content becomes part of the rendered text.
    // Collapse both splits so the result is:
    //
    //   <textarea ...attrs...><%= val %></textarea>
    //
    // Pattern:
    //   (>)           — the closing > of the opening tag (already on its own line or inline)
    //   \n[ \t]*      — newline + any indentation Prettier added before the content
    //   (...)         — the inline content (single line, non-greedy), with no tag
    //                   in it, so the `>` is the textarea's own and not that of
    //                   an element on the line above
    //   (<\/...)      — start of the closing tag
    //   \n[ \t]*      — newline + whitespace before the stray >
    //   (>)           — the stray > that closes the closing tag
    restoredCode = restoredCode.replace(
        /(>)\n[ \t]*((?:(?!<\/?[a-zA-Z])[^\n])+?)(<\/(?:textarea|pre))\n[ \t]*(>)/gi,
        '$1$2$3$4'
    );

    return restoredCode;
}