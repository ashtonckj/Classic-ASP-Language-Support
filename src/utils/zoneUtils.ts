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
 *
 * The scan is intentionally literal for the block delimiters themselves
 * (VBScript strings / comments cannot contain `%>` in a way that would fool
 * us in practice), which matches the original behaviour.
 */
function isInsideAspBlock(text: string, offset: number): boolean {
    let i = 0;
    let inAsp = false;

    while (i < text.length) {
        if (!inAsp) {
            const openIdx = text.indexOf('<%', i);
            if (openIdx === -1 || openIdx >= offset) return false;
            inAsp = true;
            i = openIdx + 2;
        } else {
            const closeIdx = text.indexOf('%>', i);
            if (closeIdx === -1) return true;         // unclosed block — offset is inside
            if (offset < closeIdx + 2) return true;   // offset is before or within %>
            inAsp = false;
            i = closeIdx + 2;
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
 *   • an HTML comment  (<!-- ... -->)
 *   • an ASP block     (<% ... %>)
 *   • a VBScript string or line comment inside an ASP block
 *
 * Returns -1 if none is found before `stopBefore` (default: end-of-string).
 *
 * How the walk works
 * ------------------
 * We walk character-by-character (jumping in bulk where safe) and maintain two
 * state bits:
 *   inAsp  — we are inside <% ... %>
 *
 * Inside an ASP block we also skip VBScript strings ("...") and line comments
 * (' ... \n) so that a %> inside a string can't fool us — and so that a
 * `<style` inside a VBScript string doesn't get counted as a real tag.
 */
function findNextRealTag(
    text: string,
    tag: string,
    from: number,
    stopBefore: number = text.length,
): number {
    let i = from;
    let inAsp = false;

    while (i < stopBefore) {
        const ch = text[i];

        if (inAsp) {
            // ----------------------------------------------------------------
            // Inside an ASP block — skip VBScript constructs so we don't
            // misinterpret their contents, then watch for %>
            // ----------------------------------------------------------------
            if (ch === '"') {
                i = skipVbsString(text, i);
                continue;
            }
            if (ch === "'") {
                // Could be a VBScript comment OR an HTML attribute quote that
                // leaked here — treat it as a line comment (safe for .asp).
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

        // --------------------------------------------------------------------
        // Outside ASP — watch for context openers before checking for tag
        // --------------------------------------------------------------------

        // HTML comment
        if (ch === '<' && text.startsWith('!--', i + 1)) {
            i = skipHtmlComment(text, i);
            continue;
        }

        // ASP block
        if (ch === '<' && text[i + 1] === '%') {
            inAsp = true;
            i += 2;
            continue;
        }

        // Candidate tag?
        if (text.startsWith(tag, i)) {
            // Extra guard: the character right after the tag name must be
            // whitespace, `>`, or `/` — so `<scriptx` won't match `<script`.
            const afterTag = i + tag.length;
            const next = text[afterTag];
            if (next === undefined || /[\s>/]/.test(next)) {
                return i;
            }
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