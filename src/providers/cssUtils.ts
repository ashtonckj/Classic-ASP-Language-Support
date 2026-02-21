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

/**
 * Detects if the cursor is inside a style="" attribute value and returns
 * the info needed to build a virtual CSS document for inline styles.
 *
 * Returns null if the cursor is not inside a style="" attribute.
 */
export function getInlineStyleContext(
    content: string,
    offset: number
): { valueStart: number; valueEnd: number; wrappedOffset: number } | null {
    // Search up to 500 chars before the cursor for style=" or style='
    const searchStart = Math.max(0, offset - 500);
    const searchArea = content.slice(searchStart, offset);

    // Match style=" or style=' and capture the opening quote character
    const styleAttrMatch = searchArea.match(/style\s*=\s*(["'])([\s\S]*)$/i);
    if (!styleAttrMatch) return null;

    const openingQuote = styleAttrMatch[1]; // " or '
    const valueStart = searchStart + styleAttrMatch.index! + styleAttrMatch[0].length - styleAttrMatch[2].length;

    // Find the closing quote — search forward from the cursor position
    // but also check if the very next character IS the closing quote (cursor right before it)
    let closeQuoteIdx = content.indexOf(openingQuote, offset);

    // If no closing quote found at all, bail out
    if (closeQuoteIdx === -1) return null;

    // Make sure we haven't jumped past a tag boundary (> before the closing quote)
    const tagClose = content.indexOf('>', offset);
    if (tagClose !== -1 && tagClose < closeQuoteIdx) return null;

    const valueEnd = closeQuoteIdx;

    // Build wrapped offset — "* {  " is 5 chars (double space so CSS service
    // sees whitespace and returns all property suggestions from the start)
    const WRAPPER_PREFIX_LEN = 5; // "* {  "
    const relativeOffset = offset - valueStart;
    // Always add 1 to ensure we land inside the declaration list, not before it
    const wrappedOffset = WRAPPER_PREFIX_LEN + relativeOffset + 1;

    return { valueStart, valueEnd, wrappedOffset };
}

/**
 * Builds a virtual CSS TextDocument for an inline style="" attribute.
 * Wraps the declaration list in a fake ruleset so the CSS service
 * can parse it as valid CSS and return property/value completions.
 */
export function buildInlineCssDoc(
    uri: string,
    content: string,
    version: number,
    valueStart: number,
    valueEnd: number
): LsTextDocument {
    const declarations = content.slice(valueStart, valueEnd);
    // Add a space after opening brace so the CSS service always sees
    // at least one character of whitespace to anchor completions against
    const wrappedCss = `* {  ${declarations} }`;
    return LsTextDocument.create(uri + '.inline.css', 'css', version, wrappedCss);
}