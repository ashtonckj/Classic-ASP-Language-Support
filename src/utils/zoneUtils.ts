/**
 * zoneUtils.ts
 * Core shared utilities for zone detection inside .asp files.
 */

export type Zone = 'asp' | 'css' | 'js' | 'html';

/**
 * Returns true when `offset` falls inside a <% ... %> ASP block.
 * Any <% %> will be considered as an ASP block but...
 * For UX, the listed will not be considered as an ASP block:
 * i) Closing ASP tag (%>) in ASP comments (')
 * ii) Closing ASP tag (%>) inside a string literal ("...")
 */
function isInsideVirtualAspBlock(text: string, offset: number): boolean {
    let i = 0;
    let inAsp = false;

    while (i < text.length) {
        if (!inAsp) {
            const openIdx = text.indexOf('<%', i);
            if (openIdx === -1 || openIdx >= offset) { return false; }

            inAsp = true;
            i = openIdx + 2;
        } else {
            const lineEnd = text.indexOf('\n', i);
            const end = lineEnd === -1 ? text.length : lineEnd + 1;

            let j = i;
            let inStr = false;
            let found = false;

            while (j < end) {
                const ch = text[j];

                if (inStr) {
                    if (ch === '"') {
                        if (j + 1 < end && text[j + 1] === '"') { j += 2; continue; }
                        inStr = false;
                    }
                    j++;
                    continue;
                }

                if (ch === '"') { inStr = true; j++; continue; }

                if (ch === "'") {
                    // VBScript comment — ignore any %> for the rest of this line
                    // but we still need to check if offset is on this line
                    if (offset < end) { return true; }
                    i = end;
                    found = true;
                    break;
                }

                if (ch === '%' && j + 1 < text.length && text[j + 1] === '>') {
                    const closeEnd = j + 2;
                    if (offset < closeEnd) { return true; }
                    inAsp = false;
                    i = closeEnd;
                    found = true;
                    break;
                }

                j++;
            }

            if (!found) {
                if (offset < end) { return true; }
                i = end;
            }
        }
    }

    return false;
}

/**
 * Returns true when `offset` falls inside a <% ... %> ASP block.
 * Strictly literal — %> always closes, regardless of strings or comments.
 */
function isInsideActualAspBlock(text: string, offset: number): boolean {
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
    if (isInsideVirtualAspBlock(fullText, offset)) { return 'asp'; }

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