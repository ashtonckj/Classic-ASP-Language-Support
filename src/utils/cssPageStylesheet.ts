/**
 * cssPageStylesheet.ts  (utils/)
 *
 * The parsed CSS of every <style> block on a page, shared by the two features
 * that both want it after every edit: the colour provider, which VS Code
 * re-requests on every change, and validation, on its 400 ms debounce. They run
 * within a few hundred milliseconds of each other and each used to build and
 * parse the same thing.
 *
 * Each block is parsed on its own, into a document holding just that block's
 * body — see buildCssBodyDoc for why the blocks are not merged into one
 * document, and why the bodies are no longer padded to page length. Positions
 * therefore come back relative to the block, and `pagePosition` / `pageOffset`
 * shift them onto the page.
 *
 * The key carries the block ranges as well as the version, because the two
 * callers do not always agree on which blocks count — validation rejects a
 * <style> written inside a <script> or an HTML comment, the colour provider does
 * not. When they agree, which is every page without such a block, they share one
 * entry and the CSS is parsed once.
 *
 * The text itself is part of the key rather than just its version. Keying on the
 * version alone assumes a document's version always moves when its content does,
 * and a stale parse under that assumption does not fail loudly — it hands back
 * the colours and squiggles of the previous text, positioned against the current
 * one. Comparing the string costs a fraction of the parse it protects.
 */

import type { Stylesheet } from 'vscode-css-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { buildCssBodyDoc, cssLanguageService } from './cssUtils';

export interface ParsedCssBlock {
    /** Where this block's body sits in the page. */
    range: { start: number; end: number };
    /** Holds the block's body only; offsets are relative to `range.start`. */
    cssDoc: LsTextDocument;
    stylesheet: Stylesheet;
}

let _cacheKey: string | undefined;
let _cacheContent: string | undefined;
let _cached: ParsedCssBlock[] | undefined;

/** Every <style> body in `ranges`, parsed. Empty when there is no CSS. */
export function getParsedCssBlocks(
    uri: string,
    content: string,
    version: number,
    ranges: Array<{ start: number; end: number }>,
): ParsedCssBlock[] {
    if (ranges.length === 0) { return []; }

    const key = uri + '|' + version + '|' + ranges.map(r => r.start + ':' + r.end).join(',');
    if (_cacheKey === key && _cacheContent === content && _cached) { return _cached; }

    const blocks: ParsedCssBlock[] = ranges.map(range => {
        const cssDoc = buildCssBodyDoc(uri, content, version, range);
        return { range, cssDoc, stylesheet: cssLanguageService().parseStylesheet(cssDoc) };
    });

    _cached = blocks;
    _cacheKey = key;
    _cacheContent = content;
    return blocks;
}

/**
 * A position inside a block's document, as a position on the page.
 *
 * Only the first line needs its character shifted: every later line of the block
 * starts at column 0 in both the block and the page.
 */
export function pagePosition(
    blockStart: { line: number; character: number },
    position: { line: number; character: number },
): { line: number; character: number } {
    return {
        line: blockStart.line + position.line,
        character: position.line === 0
            ? blockStart.character + position.character
            : position.character,
    };
}

/** An offset inside a block's document, as an offset in the page. */
export function pageOffset(block: ParsedCssBlock, offset: number): number {
    return block.range.start + offset;
}
