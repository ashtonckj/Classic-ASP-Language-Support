/**
 * zoneUtils.ts
 * Core shared utilities for zone detection inside .asp files.
 */

export type Zone = 'asp' | 'css' | 'js' | 'html';

// ---------------------------------------------------------------------------
// Low-level scanners
// ---------------------------------------------------------------------------

/**
 * Starting at `start`, skip past a VBScript line comment (`' ...` to EOL).
 * Returns the index of the newline character (or end-of-string) so the caller
 * can advance past it themselves.
 */
function skipVbsLineComment(text: string, start: number): number {
    const nl = text.indexOf('\n', start);
    return nl === -1 ? text.length : nl;
}

/**
 * Starting at `start` (the opening quote), skip past a VBScript double-quoted
 * string.  VBScript uses `""` as the escape for a literal quote — no backslash
 * escaping.  Returns the index *after* the closing quote, or end-of-string if
 * the string is never closed.
 */
function skipVbsString(text: string, start: number): number {
    let i = start + 1; // skip the opening "
    while (i < text.length) {
        if (text[i] === '"') {
            // "" is an escaped quote — keep going
            if (text[i + 1] === '"') { i += 2; continue; }
            return i + 1; // past the closing quote
        }
        i++;
    }
    return text.length;
}

/**
 * Starting at `start` (the opening `<`), skip past an HTML comment
 * `<!-- ... -->`.  Returns the index after `-->`, or end-of-string.
 */
function skipHtmlComment(text: string, start: number): number {
    // caller has already verified text[start..start+4] === '<!--'
    const end = text.indexOf('-->', start + 4);
    return end === -1 ? text.length : end + 3;
}

// ---------------------------------------------------------------------------
// ASP block scanner
// ---------------------------------------------------------------------------

/**
 * Returns true when `offset` falls inside a <% ... %> ASP block.
 */
function isInsideAspBlock(fullText: string, offset: number): boolean {
    let pos = 0;
    let inAsp = false;

    while (pos < fullText.length) {
        if (!inAsp) {
            const openIdx = fullText.indexOf('<%', pos);
            if (openIdx === -1 || openIdx >= offset) return false;
            inAsp = true;
            pos = openIdx + 2;
        } else {
            const closeIdx = fullText.indexOf('%>', pos);
            if (closeIdx === -1) return true;         // unclosed block — offset is inside
            if (offset < closeIdx + 2) return true;   // offset is before or within %>
            inAsp = false;
            pos = closeIdx + 2;
        }
    }

    return false;
}

// ---------------------------------------------------------------------------
// Context-aware tag finder
// ---------------------------------------------------------------------------

/**
 * Scan `text` from position `from` and return the index of the next real
 * occurrence of `tag` (e.g. `'<style'`, `'<script'`, `'</style>'`) that is
 * NOT inside:
 *   • an HTML comment   (<!-- ... -->)
 *   • an ASP block      (<% ... %>)
 *   • a VBScript string or line comment inside an ASP block
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
 * Inside an ASP block we also skip VBScript strings ("...") and line comments
 * (' ... \n) so that a %> inside a string can't fool us — and so that a
 * `<script` inside a VBScript string literal isn't counted as a real tag.
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
            if (ch === '"') {
                i = skipVbsString(text, i);
                continue;
            }
            if (ch === "'") {
                i = skipVbsLineComment(text, i + 1);
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
// Public helpers (isInsideCssBlock / isInsideJsBlock) used by getZone
// ---------------------------------------------------------------------------

interface JsBlockInfo {
    inside: boolean;
    isVbs: boolean; // true → treat as asp zone
}

/**
 * Find the index of the `>` that terminates the opening tag beginning at/after
 * `from`. A `>` is only the terminator when it is NOT inside:
 *   • an ASP block            `<% … %>`  — the `>` in `type="<%= x %>"` is the
 *     end of the ASP delimiter, not the tag (lexical: first `%>` wins, matching
 *     the ASP engine — see isInsideAspBlock).
 *   • a quoted attribute value `"…"` / `'…'` — the `>` in `title="a > b"` is
 *     literal attribute text.
 * Returns -1 if no terminator is found (e.g. an unterminated ASP block).
 *
 * NOTE: this mirrors findTagClose() in jsUtils.ts, which the JS zone path
 * already uses. The CSS/zone path historically used a naive indexOf('>') and so
 * mis-detected these cases; both should ultimately share this one implementation
 * (plan Module 1).
 */
export function findTagEnd(text: string, from: number): number {
    let i = from;
    let inString = false;
    let quote = '';

    while (i < text.length) {
        const ch = text[i];

        if (inString) {
            if (ch === quote) { inString = false; quote = ''; }
            i++;
            continue;
        }
        if (ch === '<' && text[i + 1] === '%') {
            const aspEnd = text.indexOf('%>', i + 2);
            if (aspEnd === -1) { return -1; } // unterminated ASP block
            i = aspEnd + 2;
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

/**
 * Returns true if `offset` is inside a real `<style>…</style>` block —
 * one that is not inside an HTML comment or ASP block.
 */
function isInsideCssBlock(text: string, offset: number): boolean {
    let searchFrom = 0;

    while (true) {
        // Find the next real <style opening tag
        const styleOpen = findNextRealTag(text, '<style', searchFrom, offset);
        if (styleOpen === -1) return false; // no real <style before offset

        // Find the end of the opening tag's attribute list — skipping ASP blocks
        // and quoted attribute values so a `>` inside `type="<%= x %>"` or
        // `title="a > b"` is not mistaken for the tag terminator.
        const styleTagEnd = findTagEnd(text, styleOpen);
        if (styleTagEnd === -1) return false;

        // The cursor must be past the end of the opening tag
        if (offset <= styleTagEnd) return false;

        // Find the matching </style> — searching from after the opening tag.
        // Case-insensitive + whitespace-tolerant so </STYLE> and </style > also
        // close the block (HTML tag names are not case-sensitive). Content inside
        // <style> is CSS, not VBScript, so the close cannot be hidden in a string.
        const { index: styleClose, length: closeLen } = findClosingTag(text, 'style', styleTagEnd + 1);
        if (styleClose === -1 || offset <= styleClose) {
            return true; // offset is inside this block
        }

        searchFrom = styleClose + closeLen;
    }
}

/**
 * Walks all real `<script>…</script>` blocks and returns information about
 * whether `offset` falls inside one, and if so what kind.
 */
function isInsideJsBlock(text: string, offset: number): JsBlockInfo {
    const NOT_INSIDE: JsBlockInfo = { inside: false, isVbs: false };
    let searchFrom = 0;

    while (true) {
        const scriptOpen = findNextRealTag(text, '<script', searchFrom, offset);
        if (scriptOpen === -1) return NOT_INSIDE;

        const scriptTagEnd = findTagEnd(text, scriptOpen);
        if (scriptTagEnd === -1) return NOT_INSIDE;

        if (offset <= scriptTagEnd) return NOT_INSIDE;

        const attrs = text.slice(scriptOpen + 7, scriptTagEnd);
        const { index: scriptClose, length: closeLen } = findClosingTag(text, 'script', scriptTagEnd + 1);

        if (scriptClose === -1 || offset <= scriptClose) {
            // Offset is inside this script block
            if (isVbScriptTag(attrs)) {
                return { inside: true, isVbs: true };
            }
            const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
            const isNonJs = typeMatch && !/javascript|module/i.test(typeMatch[1]);
            if (!isNonJs) {
                return { inside: true, isVbs: false };
            }
            // Known non-JS type (e.g. text/template) — not a JS zone
            return NOT_INSIDE;
        }

        searchFrom = scriptClose + closeLen;
    }
}

// ---------------------------------------------------------------------------
// VBScript tag helper (unchanged)
// ---------------------------------------------------------------------------

/**
 * Returns true if the attributes of a <script> tag indicate VBScript —
 * both server-side and client-side should be treated as the ASP zone.
 */
function isVbScriptTag(attrs: string): boolean {
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    if (typeMatch && /vbscript/i.test(typeMatch[1])) { return true; }
    if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs)) { return true; }
    return false;
}

export function getZone(fullText: string, offset: number): Zone {
    // 1. ASP zone — <% ... %> blocks
    if (isInsideAspBlock(fullText, offset)) { return 'asp'; }

    // 2. CSS zone — inside a real <style> … </style>
    if (isInsideCssBlock(fullText, offset)) { return 'css'; }

    // 3. Script zone — inside a real <script> … </script>
    const jsInfo = isInsideJsBlock(fullText, offset);
    if (jsInfo.inside) {
        return jsInfo.isVbs ? 'asp' : 'js';
    }

    // 4. Fall back to HTML
    return 'html';
}