// Tag facts the typing and structure rules need. Completion takes its tags and
// attributes from the HTML language service, as a .html file does.

/** The void elements — `<br>`, `<img>`, `<input>`… — which never have a closing tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export function isSelfClosingTag(tagName: string): boolean {
    return VOID_ELEMENTS.has(tagName.toLowerCase());
}

// Phrasing elements that sit inside a line of text, which the Enter and Tab
// indent rules do not indent under.
const INLINE_TAGS = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd',
    'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub',
    'sup', 'time', 'u', 'var',
]);

export function isInlineTag(tagName: string): boolean {
    return INLINE_TAGS.has(tagName.toLowerCase());
}
