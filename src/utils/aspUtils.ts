/**
 * aspUtils.ts
 * Core shared utilities for zone detection inside .asp files.
 * Imported by cssUtils.ts and jsUtils.ts — do not put CSS or JS specific code here.
 *
 * Fixes vs previous version:
 *   • getZone JS zone detection now filters out <script type="vbscript"> and
 *     <script language="vbscript"> blocks, matching the logic in
 *     buildVirtualJsContent.  Previously those blocks were incorrectly
 *     reported as zone 'js'.
 */

export type Zone = 'asp' | 'css' | 'js' | 'html';

/**
 * Returns true when `offset` falls inside a <% ... %> ASP block.
 *
 * Scans line-by-line so that %> inside a VBScript comment line (') is
 * never mistaken for a real close tag:
 *   ' HOW TO USE: %> tag placement.   ← ignored correctly
 *
 * Also ignores %> inside string literals on non-comment lines.
 */
export function isInsideAspBlock(text: string, offset: number): boolean {
    let i     = 0;
    let inAsp = false;

    while (i < text.length) {
        if (!inAsp) {
            // Advance through HTML comments — any <% inside <!-- --> is not real ASP.
            if (text.slice(i, i + 4) === '<!--') {
                const closeIdx = text.indexOf('-->', i + 4);
                if (closeIdx === -1 || offset < closeIdx + 3) { return false; }
                i = closeIdx + 3;
                continue;
            }

            // Find next <%, but verify it isn't itself inside an HTML comment.
            const openIdx = text.indexOf('<%', i);
            if (openIdx === -1 || openIdx >= offset) { return false; }

            const commentStart = text.indexOf('<!--', i);
            if (commentStart !== -1 && commentStart < openIdx) {
                const commentEnd = text.indexOf('-->', commentStart + 4);
                if (commentEnd === -1 || offset <= commentEnd + 2) { return false; }
                i = commentEnd + 3;
                continue;
            }

            inAsp = true;
            i     = openIdx + 2;
        } else {
            const lineEnd = text.indexOf('\n', i);
            const end     = lineEnd === -1 ? text.length : lineEnd + 1;

            let j     = i;
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
                    // VBScript comment — skip forward looking only for %>
                    while (j < end) {
                        if (text[j] === '%' && j + 1 < text.length && text[j + 1] === '>') {
                            const closeEnd = j + 2;
                            if (offset < closeEnd) { return true; }
                            inAsp = false;
                            i     = closeEnd;
                            found = true;
                            break;
                        }
                        j++;
                    }
                    if (!found) {
                        if (offset < end) { return true; }
                        i = end;
                        found = true;
                    }
                    break;
                }

                if (ch === '%' && j + 1 < text.length && text[j + 1] === '>') {
                    const closeEnd = j + 2;
                    if (offset < closeEnd) { return true; }
                    inAsp = false;
                    i     = closeEnd;
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
 * Returns true if `attrs` (the raw attribute string of a <script> tag)
 * indicates a non-JS script type that should not be treated as a JS zone.
 * Mirrors the filtering logic in buildVirtualJsContent (jsUtils.ts) exactly.
 */
function isNonJsScriptTag(attrs: string): boolean {
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    if (typeMatch && !/javascript|module/i.test(typeMatch[1])) { return true; }
    if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs)) { return true; }
    return false;
}

/**
 * Detects which language zone the cursor is in within a .asp file.
 * Returns 'asp', 'css', 'js', or 'html'.
 */
export function getZone(content: string, offset: number): Zone {
    // ASP zone — use comment-aware scanner
    if (isInsideAspBlock(content, offset)) { return 'asp'; }

    // CSS zone — inside <style> ... </style>
    let searchFrom = 0;
    while (true) {
        const styleOpen = content.indexOf('<style', searchFrom);
        if (styleOpen === -1 || styleOpen >= offset) { break; }
        const styleTagEnd = content.indexOf('>', styleOpen);
        if (styleTagEnd === -1) { break; }
        const styleClose = content.indexOf('</style>', styleTagEnd);
        if (styleTagEnd < offset && (styleClose === -1 || offset <= styleClose)) { return 'css'; }
        searchFrom = styleClose === -1 ? content.length : styleClose + 8;
    }

    // JS zone — inside <script> ... </script>
    // Filters out VBScript and other non-JS script types, consistent with
    // buildVirtualJsContent in jsUtils.ts.
    searchFrom = 0;
    while (true) {
        const scriptOpen = content.indexOf('<script', searchFrom);
        if (scriptOpen === -1 || scriptOpen >= offset) { break; }

        const scriptTagEnd = content.indexOf('>', scriptOpen);
        if (scriptTagEnd === -1) { break; }

        // Extract the attributes portion of the opening tag
        const attrs = content.slice(scriptOpen + 7, scriptTagEnd); // 7 = '<script'.length

        const scriptClose = content.indexOf('</script>', scriptTagEnd);

        if (!isNonJsScriptTag(attrs) &&
            scriptTagEnd < offset &&
            (scriptClose === -1 || offset <= scriptClose)) {
            return 'js';
        }

        searchFrom = scriptClose === -1 ? content.length : scriptClose + 9;
    }

    return 'html';
}