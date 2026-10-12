import type * as prettier from 'prettier';
import { formatSingleAspBlock, aspFormatterSettings, delimitersAtColumnZero, pageNames, type AspFormatterSettings } from './aspFormatter';
import { aspTagProblems, findNextRealTag, findTagEnd, findClosingTag, getVbScriptBlockRanges } from '../core/zoneUtils';
import { analyseHtmlStructure } from '../core/htmlStructure';
import { VOID_ELEMENTS } from '../constants/htmlTags';
import { pageLanguage } from '../vbscript/pageSegments';
import { formatterSettings, prettierSettings as readPrettierSettings, type PrettierSettings } from '../platform/settings';
import { loadPrettier } from '../core/lazyModule';
import { lineOf, OffsetMap, offsetOf, replaceRecorded, toOriginal } from './offsetMap';

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
    /** In an attribute value: its quote ('' when unquoted), and its text before the block. */
    quote?:     string;
    prefix?:    string;
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

/**
 * The names of one format's placeholders. Each is numbered from 0, and carries
 * a tag the page does not contain, so none can be mistaken for the page's own
 * text. Both are worked out from the page alone: the same page gets the same
 * names, so the same widths, and Prettier lays it out the same way every time.
 * (The tag was a timestamp and a random string, whose length varied, and with
 * it, now and then, where a long line wrapped.)
 */
export class PlaceholderNames {
    private next = 0;
    /** Eight characters; with `tail`, sixteen. */
    readonly tag: string;
    readonly tail = 'aspfmt0';

    constructor(page: string) {
        let n = 0;
        while (page.includes(`_${n.toString(36).padStart(8, '0')}`)) { n++; }
        this.tag = n.toString(36).padStart(8, '0');
    }

    /** The next number. */
    number(): number { return this.next++; }

    /** A placeholder id: `ASPPH3_00000000_aspfmt0`. */
    id(prefix: string, number: number): string { return `${prefix}${number}_${this.tag}_${this.tail}`; }
}

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
function maskJsEventAttrs(code: string, names: PlaceholderNames, map: OffsetMap): { masked: string; masks: JsAttrMask[] } {
    const masks: JsAttrMask[] = [];
    const masked = replaceRecorded(code, JS_EVENT_ATTR_RE, (_, attrName, _fullVal, dq, sq) => {
        const inner = dq ?? sq;
        const quote = dq !== undefined ? '"' : "'";
        const token = `JSEVT${names.number()}_${names.tag}`;
        masks.push({ token, original: inner, quote });
        return `${attrName}=${quote}${token}${quote}`;
    }, map);
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
    /** Inside an unquoted attribute value: `href=page.asp?id=`. */
    private unquoted  = false;
    /** The current attribute value so far, its quote excluded. */
    private value     = '';
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
        // Straight after `=`, or inside an unquoted value, the block is part of the value.
        if (this.inTag)     { return this.unquoted || this.lastSolid === '=' ? 'inline' : 'midtag'; }
        return 'normal';
    }

    /** For an `inline` block: the value's quote ('' when unquoted) and its text before the block. */
    attribute(): { quote: string; prefix: string } {
        return { quote: this.attrQuote, prefix: this.attrQuote || this.unquoted ? this.value : '' };
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
            if (ch === this.attrQuote) { this.attrQuote = ''; } else { this.value += ch; }
            return;
        }
        if (this.inTag) {
            if (ch === '>' || /\s/.test(ch)) {
                if (ch === '>') { this.inTag = false; }
                this.unquoted = false;
            } else if (this.unquoted) {
                this.value += ch;
            } else if (before === '=') {
                // A quote opens a value only straight after `=` (spaces allowed);
                // anything else there starts an unquoted one.
                if (ch === '"' || ch === "'") { this.attrQuote = ch; this.value = ''; } else { this.unquoted = true; this.value = ch; }
            }
            return;
        }
        if (ch === '<') { this.pending = '<'; }
    }
}

/**
 * Quotes each unquoted attribute value that holds a placeholder, given where
 * each value starts and where a placeholder in it ends, in page order. Prettier
 * ends an unquoted value at its first `=`, so `href=a.asp?id=<%= id %>` came
 * back as `href="a.asp?id" ="…"`.
 */
function quoteUnquotedValues(text: string, values: Array<[number, number]>, map: OffsetMap): string {
    let out = '';
    let last = 0;
    for (const [start, from] of values) {
        if (start < last) { continue; }   // a second placeholder in a value already quoted
        let end = from;
        while (end < text.length && text[end] !== '>' && !/\s/.test(text[end])) { end++; }
        const quote = text.slice(start, end).includes('"') ? "'" : '"';
        out += text.slice(last, start);
        map.replaced(start, start, out.length, out.length + 1);
        out += quote + text.slice(start, end);
        map.replaced(end, end, out.length, out.length + 1);
        out += quote;
        last = end;
    }
    return out + text.slice(last);
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
 * the opening tag's `>` and the closing tag) — or of the elements named. Reuses
 * the zone scanners so ASP blocks, quoted attributes, and VBScript strings are
 * handled the same way the rest of the extension handles them.
 */
function computeRawTextRanges(text: string, names: readonly string[] = ['script', 'style']): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const name of names) {
        const tag = '<' + name;
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

/** The quote and the text so far of the JS or CSS string that `line` ends inside, if it ends inside one. */
function stringAtEnd(line: string): { quote: string; prefix: string } | undefined {
    let quote = '';
    let start = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === '\\') { i++; } else if (ch === quote) { quote = ''; }
        } else if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            start = i + 1;
        } else if (ch === '/' && line[i + 1] === '/') {
            break;
        }
    }
    return quote === '"' || quote === "'" ? { quote, prefix: line.slice(start) } : undefined;
}

/**
 * Gives each attribute value and JS/CSS string that holds a placeholder back
 * the quote it was written with — none, for an unquoted value. Prettier picks
 * its own, but what ASP writes into the value may hold the one it picked.
 * Left alone wherever the text before the placeholder is not as it was.
 */
function restoreQuotes(text: string, blocks: AspBlock[]): string {
    const found = findInOrder(text, blocks.map(placeholderOf));
    // From the end, so the places found before each are still where they were.
    for (let i = blocks.length - 1; i >= 0; i--) {
        const { quote, prefix, kind } = blocks[i];
        const at = found[i];
        if (quote === undefined || prefix === undefined || at === -1) { continue; }
        const open = at - prefix.length - 1;
        const now = text[open];
        if ((now !== '"' && now !== "'") || now === quote || text.slice(open + 1, at) !== prefix) { continue; }

        const js = kind === 'rawtext';
        let close = at;
        while (close < text.length && text[close] !== now) { close += js && text[close] === '\\' ? 2 : 1; }
        if (close >= text.length) { continue; }
        let body = text.slice(open + 1, close);
        if (js) { body = body.replace(/\\[\s\S]|['"]/g, m => m === quote ? '\\' + m : m); }
        else if (quote && body.includes(quote)) { continue; }
        text = text.slice(0, open) + quote + body + quote + text.slice(close + 1);
    }
    return text;
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
export function insertImpliedTableEndTags(html: string, map?: OffsetMap): string {
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
            const closer = '</' + stack.pop() + '>';
            map?.replaced(i, i, out.length, out.length + closer.length);
            out += closer;
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
    private size = 0;

    push(text: string): void {
        if (text) { this.pieces.push(text); this.size += text.length; }
    }

    get length(): number { return this.size; }

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
            if (last.length <= count) { count -= last.length; this.size -= last.length; this.pieces.pop(); }
            else { this.pieces[this.pieces.length - 1] = last.slice(0, last.length - count); this.size -= count; count = 0; }
        }
    }

    /** Removes characters from the end for as long as `test` holds. */
    dropEndWhile(test: (ch: string) => boolean): void {
        while (this.pieces.length > 0) {
            const last = this.pieces[this.pieces.length - 1];
            let keep = last.length;
            while (keep > 0 && test(last[keep - 1])) { keep--; }
            this.size -= last.length - keep;
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

// ─── <script>/<style> bodies kept from Prettier ────────────────────────────
// Taken out before Prettier runs, and put back afterwards.

/** `code` with the text of each range taken out; the ranges may come in any order. */
function takeOut(code: string, ranges: Array<[number, number]>, map: OffsetMap): string {
    let masked = '';
    let last = 0;
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
        masked += code.slice(last, start);
        map.replaced(start, end, masked.length, masked.length);
        last = end;
    }
    return masked + code.slice(last);
}

/**
 * Puts each body back in place of its range, laid out by `layOut` from the
 * indent of the tag it belongs to; a null body's range is left alone. Null
 * when the ranges no longer line up with the bodies.
 */
function putBack(
    code: string, ranges: Array<[number, number]>, bodies: Array<string | null>,
    layOut: (body: string, tagIndent: string) => string,
): string | null {
    if (bodies.every(body => body === null)) { return code; }
    if (ranges.length !== bodies.length) { return null; }

    const lower = code.toLowerCase();
    let out = code;
    // From the end, so each range is still where it was found.
    for (const k of ranges.map((_, k) => k).filter(k => bodies[k] !== null).sort((a, b) => ranges[b][0] - ranges[a][0])) {
        const [start, end] = ranges[k];
        const tagAt = Math.max(lower.lastIndexOf('<script', start), lower.lastIndexOf('<style', start));
        const tagIndent = /^[ \t]*/.exec(code.slice(code.lastIndexOf('\n', tagAt) + 1, tagAt))![0];
        out = out.slice(0, start) + layOut(bodies[k]!, tagIndent) + out.slice(end);
    }
    return out;
}

/** A body as it was written, with the closing tag lined up under its opening tag. */
const asWritten = (body: string, tagIndent: string): string => body.replace(/\n[ \t]*$/, '\n' + tagIndent);

// ─── VBScript <script> blocks ──────────────────────────────────────────────
// Prettier picks a script's language from its `type` alone, so it reads
// `<script language="vbscript">` as JavaScript: it moves the code about and,
// where the VBScript happens to parse as JavaScript, adds semicolons that break
// it. The bodies are taken out before Prettier runs and put back afterwards,
// formatted the way a `<% %>` block is — which is all the code of a global.asa.

/** Takes out the body of every closed VBScript `<script>` block, in page order. */
function takeVbScriptBodies(code: string, map: OffsetMap): { masked: string; bodies: string[] } {
    const ranges = getVbScriptBlockRanges(code)
        .filter(({ end }) => /^<\/script/i.test(code.slice(end, end + 8)))
        .map(({ start, end }): [number, number] => [start, end]);
    return { masked: takeOut(code, ranges, map), bodies: ranges.map(([start, end]) => code.slice(start, end)) };
}

/**
 * Puts the bodies back into the emptied blocks, one level inside each tag.
 * Null when the blocks no longer line up with the bodies. A body with
 * `<% %>` in it is not one piece of VBScript, so it goes back as it was.
 */
function putBackVbScriptBodies(code: string, bodies: string[], settings: AspFormatterSettings): string | null {
    const empty = getVbScriptBlockRanges(code).filter(r => r.start === r.end).map(({ start, end }): [number, number] => [start, end]);
    const unit = settings.useTabs ? '\t' : ' '.repeat(settings.indentSize);
    return putBack(code, empty, bodies, (body, tagIndent) => {
        if (!body.trim() || body.includes('<%')) { return asWritten(body, tagIndent); }

        // The line breaks after the tag and before `</script>` are the tag's, not the code's.
        const vbscript = body.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
        const formatted = formatSingleAspBlock(`<%\n${vbscript}\n%>`, { ...settings, aspTagsOnSameLine: false }).formatted;
        const lines = formatted.split('\n').slice(1, -1).map(line => line.trim() ? tagIndent + unit + line : '');
        return '\n' + lines.join('\n') + '\n' + tagIndent;
    });
}

// ─── <script>/<style> bodies with <% %> statements ─────────────────────────
// A statement block in JavaScript or CSS stands for code Prettier cannot see:
// `if (ready)\n<% If admin Then %>\nshow();` read with the block as a bare word
// gained a `;` that made show() unconditional, and every format indented the
// block one level deeper. Such a body is taken out and put back as written.

/**
 * Takes out every <script>/<style> body that holds a `<% %>` statement, or a
 * `<%= %>` standing where a statement or a rule starts — what it writes may be
 * code of any shape, and Prettier ended `<script><%= js %></script>` with a `;`.
 * `bodies` lines up with computeRawTextRanges' order, null for a body left in.
 */
function takeAspScriptBodies(code: string, map: OffsetMap): { masked: string; bodies: Array<string | null> } {
    const ranges = computeRawTextRanges(code);
    const bodies = ranges.map(([start, end]) => {
        const body = code.slice(start, end);
        const isCode = (m: RegExpMatchArray) => {
            const before = body.slice(0, m.index).trimEnd();
            return !isAspExpression(m[0]) || before === '' || ';{})'.includes(before[before.length - 1]);
        };
        return [...body.matchAll(/<%[\s\S]*?%>/g)].some(isCode) ? body : null;
    });
    return { masked: takeOut(code, ranges.filter((_, k) => bodies[k] !== null), map), bodies };
}

/**
 * What formatting a page came to: the formatted text, or why the page was left
 * as it was. The formatter tells nobody; formatCommands.ts decides what the
 * user sees.
 */
export type FormatResult =
    | { ok: true; text: string }
    | {
        ok: false;
        /** What stopped it. */
        reason: 'asp-tags' | 'jscript' | 'prettier' | 'block-removed' | 'tag-removed';
        /** One or two sentences for the user. */
        message: string;
        /** 'info' when nothing is wrong with the page — it is just not one the formatter formats. */
        severity: 'warning' | 'info';
        /** More for the log, when there is more. */
        details?: string;
        /** The page's 0-based line the problem is on, when known. */
        line?: number;
    };

/** The page formatted, or the page as it was when formatting refused (the reason is lost: use formatPage). */
export async function formatCompleteAspFile(code: string): Promise<string> {
    const result = await formatPage(code);
    return result.ok ? result.text : code;
}

export async function formatPage(code: string): Promise<FormatResult> {
    // A `<%` never closed, or a `%>` outside every block, by the lexical rule IIS
    // uses: the first `%>` ends a block, even one at the end of a comment, so
    // `<% 'Response.Write x %>` is a whole block. An unclosed `<%` would run the
    // masking to the end of the page.
    if (aspTagProblems(code).length > 0) {
        return {
            ok: false, reason: 'asp-tags', severity: 'warning',
            message: 'Formatting skipped — unclosed <% or stray %> detected. Fix the ASP tag mismatch first.',
        };
    }

    // The block formatter knows VBScript only. Recasing and re-indenting a
    // JScript page's code by VBScript's rules would break it.
    if (pageLanguage(code) === 'jscript') {
        return {
            ok: false, reason: 'jscript', severity: 'info',
            message: "Formatting skipped — this page's server code is JScript, and the formatter only formats VBScript.",
        };
    }

    const prettierSettings = readPrettierSettings();
    const run: FormatRun = {
        code,
        // A token's number is part of its length, and Prettier lays a line out
        // by its length, so the numbers start again for every page — see
        // PlaceholderNames.
        names:    new PlaceholderNames(code),
        prettier: prettierSettings,
        asp:      { ...aspFormatterSettings(formatterSettings(), prettierSettings), pageNames: pageNames(code) },
        options:  prettierOptionsFor(prettierSettings),
        // Loaded on the first format rather than when the extension starts: nothing
        // else needs it, and loading it added ~40 ms to every window's startup.
        format:   loadPrettier().format,
    };

    // ── Step 1: Mask JS event-handler attribute values ───────────────────────
    // Must happen BEFORE ASP masking so values like onclick="doA('<%= val %>'); doB()"
    // are captured whole — including embedded ASP expressions — as one opaque token.
    // Each stage records what it replaced, so a Prettier error can be traced to the user's line.
    const bodiesMap = new OffsetMap();
    const jsAttrMap = new OffsetMap();
    const aspBodiesMap = new OffsetMap();
    const vbscriptBodies = takeVbScriptBodies(code, bodiesMap);
    const aspBodies = takeAspScriptBodies(vbscriptBodies.masked, aspBodiesMap);
    const { masked: jsPreMasked, masks: jsAttrMasks } = maskJsEventAttrs(aspBodies.masked, run.names, jsAttrMap);

    // <script>/<style> body ranges — ASP blocks inside them need a JS/CSS-safe
    // identifier placeholder, not an HTML comment (which Prettier would parse as
    // a JS/CSS comment and reorder around, corrupting the code).
    const rawRanges = computeRawTextRanges(jsPreMasked);

    // ── Step 2: Mask all ASP blocks ──────────────────────────────────────────
    const page = maskAspBlocks(run, jsPreMasked, rawRanges);
    page.maps.unshift(bodiesMap, aspBodiesMap, jsAttrMap);

    // ── Step 3: Run Prettier on the masked HTML ──────────────────────────────
    let prettifiedCode: string;
    try {
        prettifiedCode = await run.format(page.maskedCode, run.options);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Where Prettier stopped, in the masked text, and so in the page.
        const loc = (error as { loc?: { start?: { line: number; column: number } } }).loc?.start;
        const lineMatch = msg.match(/\((\d+):(\d+)\)/);
        const maskedLine   = loc?.line ?? (lineMatch ? Number(lineMatch[1]) : undefined);
        const maskedColumn = loc?.column ?? (lineMatch ? Number(lineMatch[2]) : 1);
        const line = maskedLine === undefined
            ? undefined
            : lineOf(code, toOriginal(offsetOf(page.maskedCode, maskedLine, maskedColumn), page.maps));
        const near = line === undefined ? '' : ` near line ${line + 1}`;

        return {
            ok: false, reason: 'prettier', severity: 'warning', line,
            message: `Couldn't format this page: Prettier could not read the HTML${near}.`,
            // The masked code is what Prettier choked on, so it goes in the log with the error.
            details: [
                `Prettier could not parse the page${near}: ${msg}`,
                maskedLine === undefined ? '' : `(That is line ${maskedLine} of the masked code below.)`,
                '=== Masked code sent to Prettier ===',
                page.maskedCode,
                '=== ASP blocks classified ===',
                ...page.aspBlocks.map(b => `  line ${b.lineNumber + 1}  kind=${b.kind}  ${b.code.slice(0, 60).replace(/\n/g, '\\n')}`),
            ].join('\n'),
        };
    }

    // ── Step 3b: Lay the page out the way it is going to end up ─────────────
    prettifiedCode = restoreQuotes(await layOutAsWritten(run, page, prettifiedCode), page.aspBlocks);

    // ── Step 3c: Verify all placeholders survived Prettier ──────────────────
    const located = locatePlaceholders(page, prettifiedCode);
    if ('ok' in located) { return located; }

    // ── Steps 4 and 5: Format each block's VBScript, and put it back ────────
    const blocks = formatAspBlocks(run, page, prettifiedCode, located.placeholderAt);
    const restored = restoreAspBlocks(run, page, prettifiedCode, located, blocks);
    if (typeof restored !== 'string') { return restored; }

    // ── Step 5b: Restore JS event-handler attribute values ──────────────────
    // Must happen after ASP blocks are restored so token text is never
    // accidentally matched inside a reconstructed ASP expression.
    // ── Step 6: Fix broken whitespace-sensitive tags (<textarea>, <pre>) ─────
    const restoredCode = fixWhitespaceSensitiveTags(restoreJsEventAttrs(restored, jsAttrMasks));

    // ── Step 7: Put back the <script>/<style> bodies, and the VBScript ones formatted ──
    // Should Prettier have dropped or added a block, nothing is changed rather
    // than a body landing in the wrong one.
    const withAspBodies = putBack(restoredCode, computeRawTextRanges(restoredCode), aspBodies.bodies, asWritten);
    if (withAspBodies === null) { return { ok: true, text: code }; }
    return { ok: true, text: putBackVbScriptBodies(withAspBodies, vbscriptBodies.bodies, run.asp) ?? code };
}

// ─── The stages of formatPage ──────────────────────────────────────────────

/** What one format of one page carries from stage to stage. */
interface FormatRun {
    /** The page as it was given. */
    code:     string;
    names:    PlaceholderNames;
    prettier: PrettierSettings;
    asp:      AspFormatterSettings;
    options:  prettier.Options;
    format:   typeof prettier.format;
}

/** The page with every <% %> block and hidden tag behind a placeholder, ready for Prettier. */
interface MaskedPage {
    maskedCode: string;
    aspBlocks:  AspBlock[];
    hiddenTags: HiddenTagPlaceholder[];
    /** What each rewrite before Prettier replaced, oldest first: see offsetMap.ts. */
    maps:       OffsetMap[];
}

/** Where each placeholder is in Prettier's output (-1 when it was dropped). */
interface PlaceholderPositions {
    placeholderAt: number[];
    hiddenAt:      number[];
}

/** Each block's VBScript formatted, and the column its delimiters go at. */
interface FormattedBlocks {
    formattedBlocks: string[];
    blockTagIndents: string[];
}

type FormatRefusal = Exclude<FormatResult, { ok: true }>;

/** The comment a statement block or a hidden tag is masked behind. */
const commentFor = ({ id }: { id: string }) => `<!--${id}-->`;

/** What a block is found by in Prettier's output: for a statement block, the id inside its comment. */
const placeholderOf = (block: AspBlock) =>
    block.kind === 'rawtext' ? rawTokenFor(block.id) :
    block.kind === 'normal'  ? block.id              :
    block.token!;

function prettierOptionsFor(prettierSettings: PrettierSettings): prettier.Options {
    return {
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
}

function maskAspBlocks(run: FormatRun, jsPreMasked: string, rawRanges: Array<[number, number]>): MaskedPage {
    // ── Step 2: Mask all ASP blocks ──────────────────────────────────────────
    // Each ASP block is replaced with a placeholder that Prettier will treat as
    // valid HTML, preserving its position in the output.
    //
    // Everything below carries its state forward — the context of the text
    // emitted so far, the current line, the line number — instead of asking the
    // whole page again for every block.

    const aspBlocks: AspBlock[] = [];
    const masked    = new TextBuilder();
    const blocksMap = new OffsetMap();
    const context   = new EmittedContext();
    /** Each unquoted attribute value with a placeholder in it: where it starts, and where the placeholder ends. */
    const unquoted: Array<[number, number]> = [];
    // Bodies whose whitespace is rendered as written.
    const verbatimRanges = computeRawTextRanges(jsPreMasked, ['pre', 'textarea']);

    // Tags Prettier must not see: one branch's copy of a tag another branch of
    // the same If opens or closes, or a tag whose partner VBScript writes. Read
    // top to bottom they look unbalanced, and Prettier re-nests the page around
    // them or appends a closing tag of its own. Each is hidden behind a comment
    // and put back afterwards, the indent it belongs at included.
    // Every element, not only the structural ones: `<p class="x">` opened in
    // both branches gained a `</p>` after the first.
    const hidden = analyseHtmlStructure(jsPreMasked, undefined, name => !VOID_ELEMENTS.has(name)).hidden;
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
        AspExpr: tokenCollisions(run.code, 'AspExpr'),
        AspAttr: tokenCollisions(run.code, 'AspAttr'),
        aspmid:  tokenCollisions(run.code, 'aspmid'),
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
            const id = run.names.id('ASPTAG', hiddenTags.length);
            hiddenTags.push({ id, text: jsPreMasked.slice(pos, end), dedent });
            const from = masked.length;
            emit(commentFor({ id }));
            blocksMap.replaced(pos, end, from, masked.length);
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

        // The block ends at the first %>, as IIS ends it, even one at the end of
        // a ' comment. formatPage has already made sure there is one.
        const close = jsPreMasked.indexOf('%>', pos + 2);
        const end   = close === -1 ? jsPreMasked.length : close + 2;

        const aspBlock = jsPreMasked.slice(pos, end);
        // A block inside a <script>/<style> body is raw-text; otherwise decide
        // from the surrounding HTML whether it is inline/midtag/normal.
        let   kind     = isInRawText(pos, rawRanges) ? 'rawtext' : context.kind();

        for (let i = countedTo; i < pos; i++) { if (jsPreMasked[i] === '\n') { lineNumber++; } }
        countedTo = pos;

        const index = run.names.number();
        const id    = run.names.id('ASPPH', index);

        // A `<%= … %>` in page content is an expression whose output is part
        // of the text around it, so it is masked as text rather than as a
        // comment — see paddedToken. This applies wherever the expression sits,
        // not only where it shares a line, so that a page already broken apart
        // by the old placeholder is pulled back together the next time it is
        // formatted.
        if (kind === 'normal' && isAspExpression(aspBlock)) { kind = 'text'; }
        // A statement block is masked as text, so left where it is, wherever a
        // line break would be rendered: inside <pre> or <textarea>, or glued to
        // text on both sides — `abc<% If x Then %>def` would render `abc def`.
        const isText = (ch: string | undefined) => ch !== undefined && /[^\s<>]/.test(ch);
        if (kind === 'normal' && (isInRawText(pos, verbatimRanges) || (isText(jsPreMasked[pos - 1]) && isText(jsPreMasked[end])))) {
            kind = 'text';
        }

        // `midtag` is emitted as `name="1"`, four characters more than the
        // name itself, so the name is padded to that much less.
        const token =
            kind === 'text'   ? paddedToken('AspExpr', index, aspBlock.length,     collisions.AspExpr) :
            kind === 'inline' ? paddedToken('AspAttr', index, aspBlock.length,     collisions.AspAttr) :
            kind === 'midtag' ? paddedToken('aspmid',  index, aspBlock.length - 4, collisions.aspmid)  :
            undefined;

        // Where the block sits in a quoted value or string, so its quote can be put back — see restoreQuotes.
        const quoting = kind === 'inline' ? context.attribute() : kind === 'rawtext' ? stringAtEnd(masked.currentLine().text) : undefined;
        aspBlocks.push({ code: aspBlock, id, lineNumber, kind, token, ...quoting });

        // Replace leading whitespace + block with the placeholder
        // (strip the leadingWS we already emitted so the placeholder
        //  takes its place cleanly)
        // Only a comment placeholder: before any other the blanks may be rendered text or a JS string's.
        let replacedFrom = pos;
        if (kind === 'normal' && leadingWS && lineTrailing.endsWith(leadingWS)) {
            replacedFrom -= leadingWS.length;
            masked.dropEnd(leadingWS.length);
            lineTrailing = lineTrailing.slice(0, lineTrailing.length - leadingWS.length);
            if (!lineHasContent) { lineLeading = lineLeading.slice(0, lineLeading.length - leadingWS.length); }
        }

        const placedAt = masked.length;
        switch (kind) {
            case 'text':    emit(token!);           break;
            case 'inline':  emit(token!);           break;
            case 'midtag':  emit(`${token}="1"`);   break;
            case 'rawtext': emit(rawTokenFor(id));  break;
            default:        emit(commentFor({ id })); break;
        }
        blocksMap.replaced(replacedFrom, end, placedAt, masked.length);
        const placed = aspBlocks[aspBlocks.length - 1];
        if (placed.quote === '') { unquoted.push([placedAt - placed.prefix!.length, masked.length]); }
        pos = end;
    }

    const quotesMap = new OffsetMap();
    let maskedCode = quoteUnquotedValues(masked.toString(), unquoted, quotesMap);

    // Insert implied </td> </tr> … closers so Prettier doesn't mis-nest tables
    // whose optional end tags were omitted (very common in Classic ASP).
    const tableMap = new OffsetMap();
    maskedCode = insertImpliedTableEndTags(maskedCode, tableMap);

    return { maskedCode, aspBlocks, hiddenTags, maps: [blocksMap, quotesMap, tableMap] };
}

async function layOutAsWritten(run: FormatRun, page: MaskedPage, firstPass: string): Promise<string> {
    const { aspBlocks, hiddenTags } = page;
    const { format, options: prettierOptions } = run;
    const normalBlocks = aspBlocks.filter(block => block.kind === 'normal');
    let prettifiedCode = firstPass;

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
    if (!run.asp.aspTagsOnSameLine) {
        // A hidden tag is a structural element — a div, a form, a table — so it
        // gets a line of its own too, rather than being left after a `%>`.
        const placeholders = [
            ...normalBlocks.map(commentFor),
            ...hiddenTags.map(commentFor),
        ];
        const at = [
            ...findInOrder(prettifiedCode, normalBlocks.map(commentFor)),
            ...findInOrder(prettifiedCode, hiddenTags.map(commentFor)),
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

    return prettifiedCode;
}

function blockRemoved(block: AspBlock): FormatRefusal {
    return {
        ok: false, reason: 'block-removed', severity: 'warning',
        message: `Formatting skipped — an ASP block on line ${block.lineNumber + 1} was removed by Prettier. `
            + `This usually happens when a <% %> block is in an unexpected position inside an HTML tag.`,
    };
}

function locatePlaceholders(page: MaskedPage, prettifiedCode: string): PlaceholderPositions | FormatRefusal {
    const { aspBlocks, hiddenTags } = page;

    // ── Step 3c: Verify all placeholders survived Prettier ──────────────────

    const found = findInOrder(prettifiedCode, aspBlocks.map(placeholderOf));

    const lost = aspBlocks.find((_, i) => found[i] === -1);
    if (lost) { return blockRemoved(lost); }

    const hiddenAt = findInOrder(prettifiedCode, hiddenTags.map(commentFor));
    if (hiddenAt.includes(-1)) {
        return {
            ok: false, reason: 'tag-removed', severity: 'warning',
            message: 'Formatting skipped — Prettier removed a tag that an If, a Select Case or a Response.Write '
                + 'opens or closes. The page was left as it was.',
        };
    }

    // Where each block's placeholder is — for a statement block, the whole
    // `<!--ID-->` comment rather than the id it was verified by.
    const placeholderAt = aspBlocks.map((block, i) => {
        if (block.kind !== 'normal') { return found[i]; }
        const comment = commentFor(block);
        return prettifiedCode.startsWith(comment, found[i] - 4) ? found[i] - 4 : prettifiedCode.indexOf(comment);
    });

    return { placeholderAt, hiddenAt };
}

function formatAspBlocks(run: FormatRun, page: MaskedPage, prettifiedCode: string, placeholderAt: number[]): FormattedBlocks {
    const { aspBlocks } = page;
    const aspSettings = run.asp;

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

    return { formattedBlocks, blockTagIndents };
}

function restoreAspBlocks(
    run: FormatRun,
    page: MaskedPage,
    prettifiedCode: string,
    { placeholderAt, hiddenAt }: PlaceholderPositions,
    { formattedBlocks, blockTagIndents }: FormattedBlocks,
): string | FormatRefusal {
    const { aspBlocks, hiddenTags } = page;
    const aspSettings = run.asp;
    const prettierSettings = run.prettier;

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
            scan = item.at + commentFor(item.tag).length;

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
                scan = at + block.token!.length;

                if (isAspExpression(block.code)) {
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
                // Prettier read the placeholder as something else; putting the token back would lose the block.
                if (!m) { return blockRemoved(block); }
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
                // content before the placeholder on the same line — unless that
                // content leaves a quote open: the placeholder is then inside an
                // attribute value, and breaking it open corrupts the HTML.
                const afterContent = isInlinePlaced(textBeforeOnLine);

                // Every restore below replaces the spaces and tabs in front of
                // the placeholder along with it.
                const blanksBefore = textBeforeOnLine.slice(textBeforeOnLine.length - trailingBlankCount(textBeforeOnLine));
                restored.dropEndWhile(isBlank);

                // With the delimiters at column 0, aspFormatter already adds the
                // HTML depth to the content indent, so the content is complete
                // and the tags go to column 0: the block's tag column is ''. With
                // the delimiters at the HTML indent, it is the group's shared
                // column (the HTML indent of the first, shallowest block of the
                // group), which goes in front of both, so every <% / %> of the
                // group aligns at the same column.
                const tagIndent = blockTagIndents[i];
                const indentedBlock = formatted
                    .split('\n')
                    .map(line => {
                        const t = line.trim();
                        if (!t) return line;
                        return tagIndent + (t === '<%' || t === '%>' ? t : line);
                    })
                    .join('\n');

                if (afterContent && !aspSettings.aspTagsOnSameLine) {
                    // Block sits inline in tag text content (e.g. <td><!--ID--></td>).
                    // Expand it onto its own indented lines.
                    const baseIndent = leadingBlanks(textBeforeOnLine);

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

                // After other content — where aspTagsOnSameLine leaves it — the
                // block stays where Prettier put it, with the space it had in
                // front. The group's tag column belongs at the start of a line:
                // mid-line it was a run of spaces, which the next format broke
                // the line at.
                if (afterContent) {
                    restored.push(blanksBefore + indentedBlock.slice(leadingBlanks(indentedBlock).length));
                    break;
                }

                restored.push(indentedBlock);
                break;
            }
        }
    }
    restored.push(prettifiedCode.slice(scan));

    return restored.toString();
}

function fixWhitespaceSensitiveTags(text: string): string {
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
    return text.replace(
        /(>)\n[ \t]*((?:(?!<\/?[a-zA-Z])[^\n])+?)(<\/(?:textarea|pre))\n[ \t]*(>)/gi,
        '$1$2$3$4'
    );
}
