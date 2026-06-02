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
 * Returns true if `offset` is inside a real `<style>…</style>` block —
 * one that is not inside an HTML comment or ASP block.
 */
function isInsideCssBlock(text: string, offset: number): boolean {
    let searchFrom = 0;

    while (true) {
        // Find the next real <style opening tag
        const styleOpen = findNextRealTag(text, '<style', searchFrom, offset);
        if (styleOpen === -1) return false; // no real <style before offset

        // Find the end of the opening tag's attribute list
        const styleTagEnd = text.indexOf('>', styleOpen);
        if (styleTagEnd === -1) return false;

        // The cursor must be past the end of the opening tag
        if (offset <= styleTagEnd) return false;

        // Find the matching </style> — searching from after the opening tag.
        // We only need a literal search here; content inside <style> is CSS,
        // not VBScript, so </style> cannot be hidden in a string/comment in
        // a meaningful way (and ASP blocks inside a style tag are very exotic).
        const styleClose = text.indexOf('</style>', styleTagEnd + 1);
        if (styleClose === -1 || offset <= styleClose) {
            return true; // offset is inside this block
        }

        searchFrom = styleClose + 8; // '</style>'.length
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

        const scriptTagEnd = text.indexOf('>', scriptOpen);
        if (scriptTagEnd === -1) return NOT_INSIDE;

        if (offset <= scriptTagEnd) return NOT_INSIDE;

        const attrs = text.slice(scriptOpen + 7, scriptTagEnd);
        const scriptClose = text.indexOf('</script>', scriptTagEnd + 1);

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

        searchFrom = scriptClose + 9; // '</script>'.length
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
    if (isInsideAspBlock(fullText, offset)) { console.log('asp'); return 'asp'; }

    // 2. CSS zone — inside a real <style> … </style>
    if (isInsideCssBlock(fullText, offset)) { console.log('css'); return 'css'; }

    // 3. Script zone — inside a real <script> … </script>
    const jsInfo = isInsideJsBlock(fullText, offset);
    if (jsInfo.inside) {
        console.log(jsInfo.isVbs ? 'asp' : 'js');
        return jsInfo.isVbs ? 'asp' : 'js';
    }

    // 4. Fall back to HTML
    console.log('html');
    return 'html';
}