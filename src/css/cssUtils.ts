/**
 * CSS-specific utilities for building virtual CSS documents from .asp files.
 * Which parts of the page are CSS — <style> bodies and style="" values — comes
 * from the page's zones (documentState's zonesFor); this module only extracts
 * and rewrites the CSS content.
 */

import type * as CssLs from 'vscode-css-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { maskAsp, type OffsetRange, type ZoneResolver } from '../core/zoneUtils';
import { loadCssService } from '../core/lazyModule';

let _cssService: CssLs.LanguageService | undefined;

/**
 * The CSS language service library, loaded on first use rather than when the
 * extension starts: it takes ~140 ms to load, and a page with no CSS in it never
 * needs it.
 */
export function cssLanguageServiceModule(): typeof CssLs {
    return loadCssService();
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
    // The placeholder keeps the block's length and line breaks: the service's
    // positions are mapped back by line and character.
    return maskAsp(css, offset => {
        // Only the few characters before the block that the checks need:
        // slicing everything before every block was quadratic in a style with
        // thousands of them.
        let end = offset;
        while (end > 0 && /\s/.test(css[end - 1])) { end--; }
        const before = css.slice(Math.max(0, end - 5), end);

        // A hex digit after '#' (#000000 …) and inside rgb()/hsl(), otherwise a
        // letter, a valid value or selector token.
        return before.endsWith('#') || /(?:rgba?|hsla?)\(\s*$/.test(before) ? '0' : 'a';
    });
}

/**
 * A virtual CSS document holding ONE <style> body and nothing else, the way
 * every CSS feature reads a block (see cssPageStylesheet.ts).
 *
 * The body is not padded with a prefix as long as everything before it on the
 * page: that rebuilt the whole prefix once per block, 198 ms at 160 blocks for
 * the same CSS that took 1 ms in one. Positions come back relative to the
 * block, and the caller shifts them.
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
 * The style="…" value `offset` is in — between its quotes, either end included —
 * when the offset is in the page's markup. A style attribute written in a
 * VBScript or JavaScript string, or in a comment, is text there, as it is in a
 * .html file, and so is the ASP inside a value.
 */
export function styleAttributeAt(zones: ZoneResolver, offset: number): OffsetRange | undefined {
    if (zones.zoneAt(offset) !== 'html') { return undefined; }
    return zones.markup.styleAttributes.find(value => value.start <= offset && offset <= value.end);
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
    return LsTextDocument.create(uri + '.inline.css', 'css', version, `${INLINE_PREFIX}${declarations} }`);
}

/**
 * What buildInlineCssDoc puts in front of a style attribute's declarations: a
 * ruleset for them to sit in, and a space after its brace so the service always
 * has whitespace to anchor a completion to, even in an empty value.
 */
export const INLINE_PREFIX = '* {  ';

/** The page offset of an offset in the document buildInlineCssDoc built for the value starting at `valueStart`. */
export function inlinePageOffset(valueStart: number, inlineOffset: number): number {
    return valueStart + inlineOffset - INLINE_PREFIX.length;
}

/** The offset in the document buildInlineCssDoc built for the value starting at `valueStart`, of a page offset. */
export function inlineDocOffset(valueStart: number, pageOffset: number): number {
    return pageOffset - valueStart + INLINE_PREFIX.length;
}