/**
 * htmlLinkUtils.ts  (html/)
 *
 * Shared helpers for detecting HTML file-link attributes.
 * Extracted from includeProvider.ts so they can be imported by
 * linkProvider.ts and aspHoverProvider.ts without creating a circular dependency.
 */

/** Attributes whose values are treated as local file paths. */
export const FILE_LINK_ATTRIBUTES = ['href', 'src', 'action', 'data-src'];

const HTML_ATTR_PATTERN = new RegExp(
    `\\b(${FILE_LINK_ATTRIBUTES.join('|')})\\s*=\\s*["']([^"']+)["']`,
    'gi'
);

/** True for values that are clearly not local files (URLs, anchors, mailto, etc.) */
export function isExternalPath(value: string): boolean {
    return /^(https?:\/\/|\/\/|mailto:|tel:|#|javascript:)/i.test(value);
}

/**
 * Returns true if the cursor character position falls inside a file-link
 * HTML attribute value on the given line.
 */
export function isCursorInHtmlFileLinkAttribute(lineText: string, character: number): boolean {
    HTML_ATTR_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HTML_ATTR_PATTERN.exec(lineText)) !== null) {
        const valueOffset = m[0].indexOf(m[2]);
        const valueStart  = m.index + valueOffset;
        const valueEnd    = valueStart + m[2].length;
        if (character >= valueStart && character <= valueEnd) return true;
    }
    return false;
}