/**
 * CSS-specific utilities for building virtual CSS documents from .asp files.
 * Zone detection (deciding the cursor is in a CSS zone) is done by callers via
 * getZone() in zoneUtils.ts; this module only extracts/rewrites the CSS content.
 */

import type * as CssLs from 'vscode-css-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { findNextRealTag, findTagEnd, findClosingTag } from './zoneUtils';

let _cssLs:      typeof CssLs | undefined;
let _cssService: CssLs.LanguageService | undefined;

/**
 * The CSS language service library, loaded on first use rather than when the
 * extension starts: it takes ~140 ms to load, and a page with no CSS in it never
 * needs it.
 */
export function cssLanguageServiceModule(): typeof CssLs {
    return (_cssLs ??= require('vscode-css-languageservice') as typeof CssLs);
}

/** The one CSS language service every CSS feature shares. Each used to create its own as it loaded. */
export function cssLanguageService(): CssLs.LanguageService {
    return (_cssService ??= cssLanguageServiceModule().getCSSLanguageService());
}

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

        // Pick a context-appropriate filler:
        //   • after '#'            → hex digit '0'   (#000000 …)
        //   • inside rgb()/hsl()   → digit '0'       (one numeric argument)
        //   • otherwise            → letter 'a'      (valid value/selector token)
        const filler =
            before.endsWith('#') || /(?:rgba?|hsla?)\(\s*$/.test(before) ? '0' : 'a';

        // CRITICAL: the placeholder MUST have the SAME length as the match AND
        // preserve interior newlines. The CSS language service maps diagnostics
        // back by (line, character); a shorter or single-line placeholder shifted
        // every warning after the expression onto the wrong column/line.
        let out = '';
        for (let i = 0; i < match.length; i++) {
            out += match[i] === '\n' ? '\n' : filler;
        }
        return out;
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
        // Next real <style> opening tag before the cursor. findNextRealTag skips
        // ASP blocks, HTML comments, and attribute strings, so it won't match a
        // `<style` that is merely text inside them. Case-insensitive.
        const styleOpen = findNextRealTag(content, '<style', searchFrom, offset);
        if (styleOpen === -1) return null;

        // End of the opening tag — skipping ASP blocks and quoted attribute values
        // so a `>` inside `type="<%= x %>"` / `title="a > b"` is not mistaken for
        // the tag terminator (which corrupted the extracted CSS).
        const styleTagEnd = findTagEnd(content, styleOpen);
        if (styleTagEnd === -1 || offset <= styleTagEnd) return null;

        const { index: styleClose, length: closeLen } = findClosingTag(content, 'style', styleTagEnd + 1);
        if (styleClose === -1 || offset <= styleClose) {
            const cssStart = styleTagEnd + 1;
            const cssEnd = styleClose === -1 ? content.length : styleClose;

            const prefix = content.slice(0, cssStart).replace(/[^\n]/g, ' ');
            const rawCss = content.slice(cssStart, cssEnd);
            const cssContent = prefix + stripAspExpressions(rawCss);

            return LsTextDocument.create(uri + '.css', 'css', version, cssContent);
        }

        searchFrom = styleClose + closeLen;
    }
}

/**
 * A virtual CSS document holding ONE <style> body and nothing else.
 *
 * buildCssDoc above pads its block with a whitespace prefix as long as
 * everything before it on the page, so an offset in the result is already a page
 * offset. That is convenient, but the two whole-page consumers — validation and
 * the colour provider — call it once per block, and each call rebuilds the whole
 * prefix. Same file, same CSS, only the block count varying, that measured 1 ms
 * at one block and 198 ms at 160: the page re-blanked once per block.
 *
 * This builds only the block, so a page costs the size of its CSS rather than
 * the size of the page times the number of blocks. Positions come back relative
 * to the block, and the caller shifts them: see cssPageStylesheet.ts.
 *
 * Parsing each block on its own is also what keeps the diagnostics right. One
 * document covering every block at once was tried first, and an unterminated
 * rule in one block then swallowed the next — the "} expected" moved from the
 * end of the block that was missing its brace to the end of the following one.
 * Mid-edit that is the normal state of a file, not an edge case.
 */
export function buildCssBodyDoc(
    uri: string,
    content: string,
    version: number,
    range: { start: number; end: number },
): LsTextDocument {
    return LsTextDocument.create(
        uri + '.' + range.start + '.css',
        'css',
        version,
        stripAspExpressions(content.slice(range.start, range.end)),
    );
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

    // Find the LAST style=" / style=' before the cursor — that is the attribute the
    // cursor is actually inside. Matching the first one broke when two styled
    // elements shared a line: the cursor in the second value fell outside the
    // first value's range and no CSS help was offered.
    const styleAttrRe = /style\s*=\s*(["'])/gi;
    let styleMatch: RegExpExecArray | null;
    let openingQuote = '';
    let valueStart = -1;
    while ((styleMatch = styleAttrRe.exec(searchArea)) !== null) {
        openingQuote = styleMatch[1];
        valueStart   = searchStart + styleMatch.index + styleMatch[0].length;
    }
    if (valueStart === -1) return null;

    // Find closing quote — search forward from valueStart (not offset) so that an empty value style="" where offset === closeQuoteIdx still works
    const closeQuoteIdx = content.indexOf(openingQuote, valueStart);
    if (closeQuoteIdx === -1) return null;

    // Cursor must be between valueStart and closeQuoteIdx (inclusive of both ends).
    // The value is fully delimited by the quotes, so a '>' between the cursor and
    // the closing quote is value text (e.g. content: ">"), not a tag boundary —
    // the old indexOf('>') check wrongly bailed on those.
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