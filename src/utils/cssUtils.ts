/**
 * CSS-specific utilities for building virtual CSS documents from .asp files.
 * Imports shared zone detection from aspUtils.ts.
 */

import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';

/**
 * Replaces ASP expressions (<%...%>) in CSS content with syntactically valid
 * CSS placeholders so the language service doesn't generate false-positive errors.
 *
 * The replacement strategy is context-aware:
 *   - After a '#' (hex colour prefix): replace with '000000' to complete the hex literal
 *   - After 'rgb(' / 'rgba(' / 'hsl(' / 'hsla(': replace each argument with '0'
 *   - Otherwise: replace with a valid token whose character count roughly matches,
 *     keeping column positions stable for accurate error mapping.
 *
 * ASP block comments (<%-- ... --%>) are treated the same way — they are also
 * invalid CSS and get the same placeholder treatment.
 */
export function stripAspExpressions(css: string): string {
    return css.replace(/<%[\s\S]*?%>/g, (match, offset) => {
        // Check what immediately precedes the ASP tag (ignoring whitespace)
        const before = css.slice(0, offset).trimEnd();

        // Hex colour: background-color: #<%=...%>
        if (before.endsWith('#')) {
            return '000000'.slice(0, Math.max(6, match.length));
        }

        // CSS function argument: rgb(<%=r%>, ...)  /  rgba(  /  hsl(  /  hsla(
        if (/(?:rgba?|hsla?)\(\s*$/.test(before)) {
            return '0';
        }

        // Generic value / selector fragment — use a valid identifier-like token.
        // Pad to the same length so character offsets in *subsequent* content stay
        // accurate (important for inline-style error position remapping).
        const placeholder = 'asp';
        return placeholder.padEnd(match.length, '_');
    });
}

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
            const rawCss = content.slice(cssStart, cssEnd);
            const cssContent = prefix + stripAspExpressions(rawCss);

            return LsTextDocument.create(uri + '.css', 'css', version, cssContent);
        }

        searchFrom = styleClose === -1 ? content.length : styleClose + 8;
    }
}

/**
 * Detects if the cursor is inside a style="" attribute value and returns the info needed
 * to build a virtual CSS document for inline styles.
 * Returns null if the cursor is not inside a style="" attribute.
 */
export function getInlineStyleContext(
    content: string,
    offset: number
): { valueStart: number; valueEnd: number; wrappedOffset: number } | null {
    const searchStart = Math.max(0, offset - 500);
    const searchArea = content.slice(searchStart, offset);

    // Match style=" or style=' and capture the opening quote
    const styleAttrMatch = searchArea.match(/style\s*=\s*(["'])([\s\S]*)$/i);
    if (!styleAttrMatch) return null;

    const openingQuote = styleAttrMatch[1];
    const valueStart = searchStart + styleAttrMatch.index! + styleAttrMatch[0].length - styleAttrMatch[2].length;

    // Find closing quote — search forward from valueStart (not offset) so that an empty value style="" where offset === closeQuoteIdx still works
    const closeQuoteIdx = content.indexOf(openingQuote, valueStart);
    if (closeQuoteIdx === -1) return null;

    // Make sure we haven't jumped past a tag boundary
    const tagClose = content.indexOf('>', offset);
    if (tagClose !== -1 && tagClose < closeQuoteIdx) return null;

    // Cursor must be between valueStart and closeQuoteIdx (inclusive of both ends)
    if (offset < valueStart || offset > closeQuoteIdx) return null;

    const valueEnd = closeQuoteIdx;

    // Wrap as "* {  <declarations> }" — prefix is 5 chars
    // We pad the offset by 2 so the CSS service always lands inside the declaration list even when the value is completely empty
    const WRAPPER_PREFIX_LEN = 5;
    const relativeOffset = offset - valueStart;
    const wrappedOffset = WRAPPER_PREFIX_LEN + relativeOffset + 2;

    return { valueStart, valueEnd, wrappedOffset };
}

/**
 * Builds a virtual CSS TextDocument for an inline style="" attribute.
 * Wraps the declaration list in a fake ruleset so the CSS service can parse it
 * as valid CSS and return property/value completions.
 */
export function buildInlineCssDoc(
    uri: string,
    content: string,
    version: number,
    valueStart: number,
    valueEnd: number
): LsTextDocument {
    const rawDeclarations = content.slice(valueStart, valueEnd);
    const declarations = stripAspExpressions(rawDeclarations);
    // Add a space after opening brace so the CSS service always sees at least one character of whitespace to anchor completions against
    const wrappedCss = `* {  ${declarations} }`;
    return LsTextDocument.create(uri + '.inline.css', 'css', version, wrappedCss);
}