import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';

export type Zone = 'asp' | 'css' | 'js' | 'html';

/**
 * Detects which language zone the cursor is in within a .asp file.
 * Returns 'asp', 'css', 'js', or 'html'.
 */
export function getZone(content: string, offset: number): Zone {
    // Check if inside <% ... %> (ASP/VBScript zone)
    let i = 0;
    while (i < offset) {
        const openIdx = content.indexOf('<%', i);
        if (openIdx === -1 || openIdx >= offset) break;
        const closeIdx = content.indexOf('%>', openIdx + 2);
        if (closeIdx === -1) return 'asp';
        if (offset > openIdx && offset < closeIdx + 2) return 'asp';
        i = closeIdx + 2;
    }

    // Check if inside a <style> block (CSS zone)
    let searchFrom = 0;
    while (true) {
        const styleOpen = content.indexOf('<style', searchFrom);
        if (styleOpen === -1 || styleOpen >= offset) break;
        const styleTagEnd = content.indexOf('>', styleOpen);
        if (styleTagEnd === -1) break;
        const styleClose = content.indexOf('</style>', styleTagEnd);
        if (styleTagEnd < offset && (styleClose === -1 || offset <= styleClose)) return 'css';
        searchFrom = styleClose === -1 ? content.length : styleClose + 8;
    }

    // Check if inside a <script> block (JS zone)
    searchFrom = 0;
    while (true) {
        const scriptOpen = content.indexOf('<script', searchFrom);
        if (scriptOpen === -1 || scriptOpen >= offset) break;
        const scriptTagEnd = content.indexOf('>', scriptOpen);
        if (scriptTagEnd === -1) break;
        const scriptClose = content.indexOf('</script>', scriptTagEnd);
        if (scriptTagEnd < offset && (scriptClose === -1 || offset <= scriptClose)) return 'js';
        searchFrom = scriptClose === -1 ? content.length : scriptClose + 9;
    }

    return 'html';
}

/**
 * Builds a position-aligned virtual CSS TextDocument from the <style> block
 * the cursor is currently inside. Returns null if the offset is not in a CSS zone.
 *
 * "Position-aligned" means everything outside the CSS content is replaced with
 * spaces/newlines so that line/column numbers stay identical to the original file.
 * This lets vscode-css-languageservice return correct ranges without any translation.
 */
export function buildCssDoc(
    uri: string,
    content: string,
    version: number,
    offset: number
): LsTextDocument | null {
    let searchFrom = 0;
    while (true) {
        const styleOpen = content.indexOf('<style', searchFrom);
        if (styleOpen === -1 || styleOpen >= offset) return null;

        const styleTagEnd = content.indexOf('>', styleOpen);
        if (styleTagEnd === -1) return null;

        const styleClose = content.indexOf('</style>', styleTagEnd);
        if (styleTagEnd < offset && (styleClose === -1 || offset <= styleClose)) {
            const cssStart = styleTagEnd + 1;
            const cssEnd = styleClose === -1 ? content.length : styleClose;

            // Replace everything before the CSS with spaces/newlines to keep positions aligned
            const prefix = content.slice(0, cssStart).replace(/[^\n]/g, ' ');
            const cssContent = prefix + content.slice(cssStart, cssEnd);

            return LsTextDocument.create(uri + '.css', 'css', version, cssContent);
        }

        searchFrom = styleClose === -1 ? content.length : styleClose + 8;
    }
}