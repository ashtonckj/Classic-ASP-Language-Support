/**
 * zoneUtils.ts
 * Core shared utilities for zone detection inside .asp files.
 */

export type Zone = 'asp' | 'css' | 'js' | 'html';

/**
 * Returns true when `offset` falls inside a <% ... %> ASP block.
 * Strictly literal — %> always closes, regardless of strings or comments.
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

/**
 * Returns true if the attributes of a <script> tag indicate server-side or client-side VBScript — both should be treated as ASP zone.
 */
function isVbScriptTag(attrs: string): boolean {
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    if (typeMatch && /vbscript/i.test(typeMatch[1])) { return true; }
    if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs)) { return true; }
    return false;
}

export function getZone(fullText: string, offset: number): Zone {
    // ASP zone — <% ... %> blocks, handles comments and strings internally
    if (isInsideAspBlock(fullText, offset)) { return 'asp'; }

    // CSS zone — inside <style> ... </style>
    let searchFrom = 0;
    while (true) {
        const styleOpen = fullText.indexOf('<style', searchFrom);
        if (styleOpen === -1 || styleOpen >= offset) { break; }

        const styleTagEnd = fullText.indexOf('>', styleOpen);
        if (styleTagEnd === -1) { break; }

        const styleClose = fullText.indexOf('</style>', styleTagEnd);
        if (styleTagEnd < offset && (styleClose === -1 || offset <= styleClose)) { return 'css'; }

        searchFrom = styleClose === -1 ? fullText.length : styleClose + 8;
    }

    // Script zone — single pass over all <script> tags to avoid misclassification.
    // VBScript blocks are treated as ASP zone; all others default to JS zone.
    searchFrom = 0;
    while (true) {
        const scriptOpen = fullText.indexOf('<script', searchFrom);
        if (scriptOpen === -1 || scriptOpen >= offset) { break; }

        const scriptTagEnd = fullText.indexOf('>', scriptOpen);
        if (scriptTagEnd === -1) { break; }

        const attrs = fullText.slice(scriptOpen + 7, scriptTagEnd);
        const scriptClose = fullText.indexOf('</script>', scriptTagEnd);

        if (scriptTagEnd < offset && (scriptClose === -1 || offset <= scriptClose)) {
            // Cursor is inside this script block — decide which zone it belongs to
            if (isVbScriptTag(attrs)) {
                return 'asp';
            }

            const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
            const isNonJs = typeMatch && !/javascript|module/i.test(typeMatch[1]);
            if (!isNonJs) {
                return 'js';
            }
        }

        searchFrom = scriptClose === -1 ? fullText.length : scriptClose + 9;
    }

    return 'html';
}