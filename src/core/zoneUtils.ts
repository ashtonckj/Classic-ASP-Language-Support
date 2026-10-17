/**
 * zoneUtils.ts
 * Core shared utilities for zone detection inside .asp files.
 */

import type * as HtmlLs from 'vscode-html-languageservice';
import { loadHtmlService } from './lazyModule';

export type Zone = 'asp' | 'css' | 'js' | 'html';

// ---------------------------------------------------------------------------
// Low-level scanners
// ---------------------------------------------------------------------------

/**
 * Starting at `start` (the opening quote), skip past a VBScript double-quoted
 * string. VBScript uses `""` as the escape for a literal quote (no backslash
 * escaping). Returns the index *after* the closing quote.
 *
 * A string cannot span lines, so one never closed ends at the line break, or
 * at a `%>` in it, which ends the block as the engine reads it. Running on
 * instead hid every <script> and <style> below a quote still being typed.
 */
function skipVbsString(text: string, start: number): number {
    let i = start + 1; // skip the opening "
    let firstClose = -1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            if (text[i + 1] === '"') { i += 2; continue; } // "" escaped quote
            return i + 1; // past the closing quote
        }
        if (ch === '\n' || ch === '\r') { return firstClose === -1 ? i : firstClose; }
        if (ch === '%' && text[i + 1] === '>' && firstClose === -1) { firstClose = i; }
        i++;
    }
    return firstClose === -1 ? text.length : firstClose;
}

// ---------------------------------------------------------------------------
// ASP blocks as the markup around them sees them
// ---------------------------------------------------------------------------

/**
 * Every `<% … %>` block, as the HTML and CSS around it read past it: from `<%`
 * to the `%>` that ends it, or to the end of the page when none does.
 *
 * Unlike getAspBlockRanges, a `%>` inside a VBScript string closed on its own
 * line, or inside a `'` comment that the line ends first, does not end the
 * block: `<% s = "%><script>" %>` writes no <script> into the markup. IIS
 * rejects such a page anyway; reading the string as markup would turn
 * everything after it into a bogus script or style.
 */
export function aspMarkupBlocks(text: string): Array<{ start: number; end: number }> {
    const blocks: Array<{ start: number; end: number }> = [];
    let open = text.indexOf('<%');
    while (open !== -1) {
        let i = open + 2;
        let end = text.length;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '"') { i = skipVbsString(text, i); continue; }
            if (ch === "'") {
                const nl    = text.indexOf('\n', i);
                const close = text.indexOf('%>', i);
                i = close !== -1 && (nl === -1 || close < nl) ? close : (nl === -1 ? text.length : nl);
                continue;
            }
            if (ch === '%' && text[i + 1] === '>') { end = i + 2; break; }
            i++;
        }
        blocks.push({ start: open, end });
        open = text.indexOf('<%', end);
    }
    return blocks;
}

/**
 * The page with every ASP block (aspMarkupBlocks) filled with `fill(blockStart)`
 * — a space unless the caller needs a token there. Line breaks, `\r` included,
 * stay, so every offset, line and column still points at the same place.
 */
export function maskAsp(
    text: string, fill: (blockStart: number) => string = () => ' ', blocks = aspMarkupBlocks(text),
): string {
    let masked = '';
    let from = 0;
    for (const block of blocks) {
        const ch = fill(block.start);
        masked += text.slice(from, block.start) + text.slice(block.start, block.end).replace(/[^\r\n]/g, () => ch);
        from = block.end;
    }
    return masked + text.slice(from);
}

// ---------------------------------------------------------------------------
// Context-aware tag finder (the formatter's; the zones come from scanMarkup)
// ---------------------------------------------------------------------------

/**
 * Scan `text` from position `from` and return the index of the next real
 * occurrence of `tag` (e.g. `'<style'`, `'<script'`, `'</style>'`) that is
 * NOT inside:
 *   • an HTML comment   (<!-- ... -->)
 *   • an ASP block      (<% ... %>)
 *   • a VBScript string or comment inside an ASP block
 *   • a sibling HTML tag's attribute list (e.g. a `<script` string inside
 *     an onclick="..." attribute of some other tag)
 *
 * Returns -1 if none is found before `stopBefore` (default: end-of-string).
 *
 * How the walk works
 * ------------------
 * Four boolean state bits are maintained:
 *   inAsp        — inside <% ... %>
 *   inHtmlComment — inside <!-- ... -->
 *   inHtmlTag    — inside the attribute list of a (non-matching) HTML tag
 *   inHtmlString — inside a quoted attribute value ("..." or '...') within
 *                  an HTML tag; sub-state of inHtmlTag
 *
 * The `>` character only closes an HTML tag (inHtmlTag → false) when we are
 * NOT inside a quoted attribute value (inHtmlString), preventing a `>` that
 * appears in e.g. onclick="a > b" from prematurely ending the tag walk.
 *
 * Inside an ASP block, VBScript strings and comments are treated as OPAQUE: a
 * `<script`/`<style` (or even a `%>`) that appears inside a `"…"` string or a
 * `'` comment is source data, not markup, so it never starts a JS/CSS zone. This
 * is what keeps `<% Response.Write "<script>…</script>" %>` from turning the rest
 * of the document into a JS zone. A comment ends at the block's `%>` or the end of
 * line, whichever comes first (ASP's `%>` ends the block even mid-comment, so real
 * markup after `<% ' note %>` is still detected).
 *
 * NOTE: this is intentionally more conservative than getAspBlockRanges, which is
 * purely lexical (first `%>` wins, even in a string — the engine's rule, used for
 * zone COLOURING). Here we favour never mis-reading string/comment content as a
 * tag, because a false JS/CSS zone produces a cascade of bogus diagnostics.
 */
export function findNextRealTag(
    text: string,
    tag: string,
    from: number,
    stopBefore: number = text.length,
): number {
    let i = from;
    let inAsp         = false;
    let inHtmlComment = false;
    let inHtmlTag     = false;
    let inHtmlString  = false;
    let htmlStringQuote = '';

    while (i < stopBefore) {
        const ch = text[i];

        // ── Inside an ASP block ──────────────────────────────────────────────
        if (inAsp) {
            // Skip VBScript strings whole — their contents (including any `<script>`,
            // `<style>`, or `%>`) are data, never markup.
            if (ch === '"') {
                i = skipVbsString(text, i);
                continue;
            }
            // A `'` comment runs to end-of-line OR the block's `%>`, whichever comes
            // first (ASP's `%>` ends the block even mid-comment). We stop *before*
            // the `%>` so the block-close check below still fires and real markup
            // after `<% ' note %>` is detected.
            if (ch === "'") {
                const nl    = text.indexOf('\n', i);
                const close = text.indexOf('%>', i);
                i = (close !== -1 && (nl === -1 || close < nl))
                    ? close
                    : (nl === -1 ? text.length : nl);
                continue;
            }
            if (ch === '%' && text[i + 1] === '>') {
                inAsp = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        // ── Inside an HTML comment ───────────────────────────────────────────
        if (inHtmlComment) {
            if (text.startsWith('-->', i)) {
                inHtmlComment = false;
                i += 3;
                continue;
            }
            i++;
            continue;
        }

        // ── Inside a quoted attribute value ─────────────────────────────────
        // Must be checked before the generic inHtmlTag branch so that a `>`
        // inside onclick="a > b" does not prematurely close the tag.
        if (inHtmlString) {
            if (ch === htmlStringQuote) {
                inHtmlString  = false;
                htmlStringQuote = '';
            }
            i++;
            continue;
        }

        // ── Inside an HTML tag's attribute list ─────────────────────────────
        if (inHtmlTag) {
            if (ch === '"' || ch === "'") {
                inHtmlString    = true;
                htmlStringQuote = ch;
                i++;
                continue;
            }
            if (ch === '>') {
                inHtmlTag = false;
            }
            i++;
            continue;
        }

        // ── Outside all special contexts ─────────────────────────────────────
        if (ch === '<') {
            if (text.startsWith('!--', i + 1)) {
                inHtmlComment = true;
                i += 4;
                continue;
            }
            if (text[i + 1] === '%') {
                inAsp = true;
                i += 2;
                continue;
            }

            // Check whether this `<` is the tag we're looking for.
            if (text.slice(i, i + tag.length).toLowerCase() === tag) {
                const afterTag = i + tag.length;
                const next = text[afterTag];
                if (next === undefined || /[\s>/]/.test(next)) {
                    return i;
                }
            }

            // A `<` with no tag-name character after it is literal body text
            // ("Show rows where qty < 5"), not markup. Treating it as a tag opener
            // started an attribute-list walk that ran to the next `>` — which could
            // be the `>` of the following <script>/<style> tag, so that whole
            // embedded block was never recognised as a JS/CSS zone.
            const afterAngle = text[i + 1];
            if (afterAngle === undefined || !/[A-Za-z/!?]/.test(afterAngle)) {
                i++;
                continue;
            }

            // Some other HTML tag — track its attribute list so we don't
            // accidentally match our target inside an attribute value.
            inHtmlTag = true;
            i++;
            continue;
        }

        i++;
    }

    return -1;
}

// ---------------------------------------------------------------------------
// Opening and closing tags in raw text (the formatter's)
// ---------------------------------------------------------------------------

/**
 * Find the index of the `>` that terminates the opening tag beginning at/after
 * `from`. A `>` is only the terminator when it is NOT inside:
 *   • an ASP block            `<% … %>`  — the `>` in `type="<%= x %>"` is the
 *     end of the ASP delimiter, not the tag (lexical: first `%>` wins, matching
 *     the ASP engine — see getAspBlockRanges).
 *   • a quoted attribute value `"…"` / `'…'` — the `>` in `title="a > b"` is
 *     literal attribute text.
 * Returns -1 if no terminator is found (e.g. an unterminated ASP block).
 */
export function findTagEnd(text: string, from: number): number {
    let i = from;
    let inString = false;
    let quote = '';

    while (i < text.length) {
        const ch = text[i];

        // ASP blocks are recognized lexically FIRST — before the attribute-string
        // state below. `<%` opens a server block regardless of surrounding HTML
        // quoting (the ASP engine runs before HTML parsing) and the first `%>`
        // closes it. If this were checked after `inString`, an attribute's opening
        // quote (e.g. title="<%= … %>") would swallow the `<%` as string text, and
        // a `>` emitted inside the ASP expression could be mistaken for the tag end.
        if (ch === '<' && text[i + 1] === '%') {
            const aspEnd = text.indexOf('%>', i + 2);
            if (aspEnd === -1) { return -1; } // unterminated ASP block
            i = aspEnd + 2;
            continue;
        }
        if (inString) {
            if (ch === quote) { inString = false; quote = ''; }
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") { inString = true; quote = ch; i++; continue; }
        if (ch === '>') { return i; }
        i++;
    }
    return -1;
}

/**
 * Case-insensitive, whitespace-tolerant search for an HTML closing tag such as
 * `</style>` or `</script>`, starting at `from`. HTML tag names are not
 * case-sensitive, so `</STYLE>` and `</style >` must match too.
 *
 * ASP blocks are skipped: a `</style>` that appears inside a `<% … %>` server
 * block is not a real element close (it is VBScript source, evaluated before the
 * browser ever sees markup). CSS/JS *string* content is deliberately NOT skipped
 * — per the HTML spec, a literal `</style>`/`</script>` inside a <style>/<script>
 * rawtext element really does close it.
 *
 * Returns the match start index (-1 if none) and matched length so callers can
 * advance past it. `tagName` is always a fixed literal, so there is no
 * regex-injection concern.
 */
export function findClosingTag(
    text: string,
    tagName: string,
    from: number,
): { index: number; length: number } {
    const re = new RegExp(`</${tagName}\\s*>`, 'iy');
    let i = from;

    while (i < text.length) {
        if (text[i] === '<' && text[i + 1] === '%') {
            const aspEnd = text.indexOf('%>', i + 2);
            i = aspEnd === -1 ? text.length : aspEnd + 2;
            continue;
        }
        if (text[i] === '<') {
            re.lastIndex = i;
            const m = re.exec(text);
            if (m) { return { index: i, length: m[0].length }; }
        }
        i++;
    }
    return { index: -1, length: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// The page's markup, read once
//
// What is markup and what is not — <script> and <style> bodies, comments,
// style="" values, the tags themselves — is read the way VS Code reads a .html
// file: by the HTML language service's scanner, over the page with its ASP
// blanked (maskAsp), so `<% %>` is never mistaken for markup or the reverse.
// Every feature that needs to know asks this, not a scanner of its own.
//
// The lists come from one forward scan, so each is sorted and non-overlapping,
// which is what makes inRanges' binary search valid.
// ─────────────────────────────────────────────────────────────────────────────

let _htmlService: HtmlLs.LanguageService | undefined;

/** The one HTML language service every markup feature shares, loaded on first use. */
function htmlService(): HtmlLs.LanguageService {
    return (_htmlService ??= loadHtmlService().getLanguageService());
}

export interface OffsetRange { start: number; end: number; }

/** A start or end tag, `<div …>` or `</div>`, from its `<` to past its `>`. */
export interface MarkupTag extends OffsetRange {
    /** Lower case; empty for a `<` the scanner found no name after. */
    name: string;
    close: boolean;
    selfClosing: boolean;
}

export interface PageMarkup {
    /** The page with its ASP blanked, as the HTML and CSS services read it. */
    masked: string;
    /** The ASP blocks blanked in `masked` (aspMarkupBlocks). */
    aspBlocks: OffsetRange[];
    tags: MarkupTag[];
    /** `<!--` to past `-->`; one never closed ends at Number.MAX_SAFE_INTEGER, as an unclosed ASP block does, so the end of the page is inside it. Bounds exclusive, as aspBlocks. */
    comments: OffsetRange[];
    /** Each <script> body, from past the opening tag's `>` to its `</script>`, or the end of the page. */
    scripts: Array<OffsetRange & { language: 'javascript' | 'vbscript' | 'other' }>;
    /** Each <style> body, bounded the same way. */
    styles: OffsetRange[];
    /** Each style="…" value, inside its quotes. */
    styleAttributes: OffsetRange[];
    /** Each on…="…" value (onclick, onchange…), inside its quotes: JavaScript, as a .html file reads it. */
    eventHandlers: OffsetRange[];
}

/** VBScript by type= or language=; JavaScript with no type or a JavaScript/module one; anything else is other. */
function scriptLanguage(attributes: Map<string, string>): 'javascript' | 'vbscript' | 'other' {
    const type = (attributes.get('type') ?? '').trim().toLowerCase();
    if (type.includes('vbscript') || (attributes.get('language') ?? '').trim().toLowerCase() === 'vbscript') { return 'vbscript'; }
    return !type || /javascript|module/.test(type) ? 'javascript' : 'other';
}

/** Reads the markup of `text`; see PageMarkup. */
export function scanMarkup(text: string): PageMarkup {
    const aspBlocks = aspMarkupBlocks(text);
    // A block standing as an unquoted value (`href=<%= u %>`) is masked as a
    // word, so the value ends where the block does; spaces would leave the
    // `=` waiting and take the next attribute for the value.
    const masked    = maskAsp(text, start => /=[ \t]*$/.test(text.slice(Math.max(0, start - 8), start)) ? 'x' : ' ', aspBlocks);
    const { TokenType } = loadHtmlService();

    const markup: PageMarkup = { masked, aspBlocks, tags: [], comments: [], scripts: [], styles: [], styleAttributes: [], eventHandlers: [] };
    let tag: MarkupTag | undefined;
    let inTag = false;
    let attribute = '';
    let attributes = new Map<string, string>();
    let body: { name: string; start: number; language: 'javascript' | 'vbscript' | 'other' } | undefined;
    let commentStart = -1;

    const closeBody = (end: number) => {
        if (!body) { return; }
        if (body.name === 'style') { markup.styles.push({ start: body.start, end }); }
        else { markup.scripts.push({ start: body.start, end, language: body.language }); }
        body = undefined;
    };

    let scanner = htmlService().createScanner(masked);
    for (let token = scanner.scan(); token !== TokenType.EOS; token = scanner.scan()) {
        const start = scanner.getTokenOffset();
        const end   = scanner.getTokenEnd();
        switch (token) {
            case TokenType.StartTagOpen:
            case TokenType.EndTagOpen:
                // A `<` with no name straight after it is text ("qty < 5"), as a
                // browser reads it. The scanner would take a name from further
                // on and swallow the tags after it into one.
                if (!/[A-Za-z]/.test(masked[end] ?? '')) {
                    scanner = htmlService().createScanner(masked, start + 1);
                    inTag = false;
                    continue;
                }
                tag = { name: '', start, end, close: token === TokenType.EndTagOpen, selfClosing: false };
                markup.tags.push(tag);
                inTag = true;
                attributes = new Map();
                break;
            case TokenType.StartTag:
            case TokenType.EndTag:
                if (!tag) { break; }
                tag.name = scanner.getTokenText().toLowerCase();
                if (tag.close && body?.name === tag.name) { closeBody(tag.start); }
                break;
            case TokenType.AttributeName:
                attribute = scanner.getTokenText().toLowerCase();
                break;
            case TokenType.AttributeValue: {
                const value  = scanner.getTokenText();
                const quoted = value[0] === '"' || value[0] === "'";
                // A quote never closed runs to the end of the page: not a value yet.
                if (quoted && (value.length < 2 || value[value.length - 1] !== value[0])) { break; }
                attributes.set(attribute, quoted ? value.slice(1, -1) : value);
                const list = attribute === 'style' ? markup.styleAttributes : /^on\w+$/.test(attribute) ? markup.eventHandlers : undefined;
                if (list && tag && !tag.close) {
                    list.push(quoted ? { start: start + 1, end: end - 1 } : { start, end });
                }
                break;
            }
            case TokenType.StartTagClose:
                if (tag && !body && (tag.name === 'script' || tag.name === 'style')) {
                    body = { name: tag.name, start: end, language: scriptLanguage(attributes) };
                }
                break;
            case TokenType.StartTagSelfClose:
                if (tag) { tag.selfClosing = true; }
                break;
            case TokenType.StartCommentTag:
                commentStart = start;
                break;
            case TokenType.EndCommentTag:
                markup.comments.push({ start: commentStart, end });
                commentStart = -1;
                break;
        }
        if (inTag && tag) {
            tag.end = end;
            if (token === TokenType.StartTagClose || token === TokenType.StartTagSelfClose || token === TokenType.EndTagClose) { inTag = false; }
        }
    }
    closeBody(text.length);
    if (commentStart !== -1) { markup.comments.push({ start: commentStart, end: Number.MAX_SAFE_INTEGER }); }
    return markup;
}

/**
 * Body ranges of every real `<script>` block that holds VBScript — either
 * `language="vbscript"` or `type="…vbscript"`, client-side or `runat="server"`.
 * Reported as the `asp` zone; exposed for callers that map VBScript spans
 * rather than probe a single offset (rename's occurrence scanner, for one).
 */
export function getVbScriptBlockRanges(text: string): OffsetRange[] {
    return scanMarkup(text).scripts.filter(s => s.language === 'vbscript').map(({ start, end }) => ({ start, end }));
}

/** Body ranges of every real `<style>` block. */
export function getCssBlockRanges(text: string): OffsetRange[] {
    return scanMarkup(text).styles;
}

/**
 * Every `<script>` body that is actually JavaScript. VBScript blocks and other
 * types (e.g. text/template) are left out: they are the 'asp' and 'html' zones.
 */
export function getJsBlockRanges(text: string): OffsetRange[] {
    return scanMarkup(text).scripts.filter(s => s.language === 'javascript').map(({ start, end }) => ({ start, end }));
}

/**
 * Every `<% … %>` block, as offsets, by the engine's lexical rule: the first
 * `%>` closes it, even one in a string. An unclosed `<%` runs to the end of the
 * document. Bounds are EXCLUSIVE at both ends: the `<` of `<%` is not inside.
 */
export function getAspBlockRanges(text: string): OffsetRange[] {
    const ranges: OffsetRange[] = [];
    let pos = 0;

    while (pos < text.length) {
        const open = text.indexOf('<%', pos);
        if (open === -1) { break; }

        const close = text.indexOf('%>', open + 2);
        ranges.push({ start: open, end: close === -1 ? Number.MAX_SAFE_INTEGER : close + 2 });
        if (close === -1) { break; }
        pos = close + 2;
    }

    return ranges;
}

/** A `%>` outside every block, or a `<%` that is never closed. */
export interface AspTagProblem {
    offset: number;
    kind: 'stray' | 'unclosed';
}

/**
 * The `<%` / `%>` mistakes in a page, by the same lexical rule IIS uses: a
 * block runs from `<%` to the first `%>` after it, even one in a string or a
 * comment. A `%>` in a VBScript `<script>` body is part of that script, not
 * stray. In page order.
 */
export function aspTagProblems(text: string, zones: ZoneResolver = createZoneResolver(text)): AspTagProblem[] {
    const problems: AspTagProblem[] = [];
    for (let at = text.indexOf('%>'); at !== -1; at = text.indexOf('%>', at + 2)) {
        if (zones.zoneAt(at) !== 'asp') { problems.push({ offset: at, kind: 'stray' }); }
    }
    // Only the last block can be unclosed: an unclosed one runs to the end of the page.
    const last = zones.aspBlocks[zones.aspBlocks.length - 1];
    if (last && last.end === Number.MAX_SAFE_INTEGER) { problems.push({ offset: last.start, kind: 'unclosed' }); }
    return problems.sort((a, b) => a.offset - b.offset);
}

/** Binary search over sorted, non-overlapping ranges. */
export function inRanges(
    ranges: ReadonlyArray<OffsetRange>,
    offset: number,
    exclusive: boolean,
): boolean {
    let lo = 0;
    let hi = ranges.length - 1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r   = ranges[mid];
        if (exclusive ? offset <= r.start : offset < r.start) { hi = mid - 1; }
        else if (exclusive ? offset >= r.end : offset > r.end) { lo = mid + 1; }
        else { return true; }
    }

    return false;
}

export interface ZoneResolver {
    zoneAt(offset: number): Zone;
    /** The ranges the zones are read from, each sorted and non-overlapping. aspBlocks' bounds are exclusive, the rest inclusive. */
    readonly aspBlocks:  ReadonlyArray<OffsetRange>;
    readonly cssBlocks:  ReadonlyArray<OffsetRange>;
    readonly vbsScripts: ReadonlyArray<OffsetRange>;
    readonly jsBlocks:   ReadonlyArray<OffsetRange>;
    /** Everything else read from the markup: comments, tags, style="" values. */
    readonly markup: PageMarkup;
}

/** Scans `text` once, then answers zone queries without touching it again. */
export function createZoneResolver(text: string): ZoneResolver {
    const markup     = scanMarkup(text);
    const aspBlocks  = getAspBlockRanges(text);
    const cssBlocks  = markup.styles;
    const vbsScripts = markup.scripts.filter(s => s.language === 'vbscript');
    const jsBlocks   = markup.scripts.filter(s => s.language === 'javascript');

    return {
        aspBlocks, cssBlocks, vbsScripts, jsBlocks, markup,
        zoneAt(offset: number): Zone {
            if (inRanges(aspBlocks, offset, true))   { return 'asp'; }
            if (inRanges(cssBlocks, offset, false))  { return 'css'; }
            if (inRanges(vbsScripts, offset, false)) { return 'asp'; }
            if (inRanges(jsBlocks, offset, false))   { return 'js'; }
            // An on…="" value is JavaScript, as VS Code's HTML support reads it.
            if (inRanges(markup.eventHandlers, offset, false)) { return 'js'; }
            return 'html';
        },
    };
}
