/**
 * cssUtils.ts
 * CSS-specific utilities for building virtual CSS documents from .asp files.
 * Imports shared zone detection from aspUtils.ts.
 */

export { getZone, Zone } from './aspUtils';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';

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

            const prefix = content.slice(0, cssStart).replace(/[^\n]/g, ' ');
            const cssContent = prefix + content.slice(cssStart, cssEnd);

            return LsTextDocument.create(uri + '.css', 'css', version, cssContent);
        }

        searchFrom = styleClose === -1 ? content.length : styleClose + 8;
    }
}