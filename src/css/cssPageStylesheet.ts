/**
 * cssPageStylesheet.ts  (css/)
 *
 * The parsed CSS of every <style> block on a page, shared by every CSS feature:
 * the colour provider, which VS Code re-requests on every change, validation,
 * on its 400 ms debounce, and completion and hover at the caret. Each used to
 * build and parse the same thing.
 *
 * Each block is parsed on its own, into a document holding just that block's
 * body — see buildCssBodyDoc for why the blocks are not merged into one
 * document, and why the bodies are not padded to page length. Positions
 * therefore come back relative to the block, and `pagePosition` / `pageOffset`
 * shift them onto the page.
 *
 * Kept with the page's version in documentState, so two pages open side by
 * side each keep their own.
 */

import type * as vscode from 'vscode';
import type { Stylesheet } from 'vscode-css-languageservice';
import { TextDocument as LsTextDocument } from 'vscode-languageserver-textdocument';
import { derivedFrom, textOf, zonesFor } from '../platform/documentState';
import { buildCssBodyDoc, cssLanguageService } from './cssUtils';

export interface ParsedCssBlock {
    /** Where this block's body sits in the page. */
    range: { start: number; end: number };
    /** Holds the block's body only; offsets are relative to `range.start`. */
    cssDoc: LsTextDocument;
    stylesheet: Stylesheet;
}

function parseBlocks(document: vscode.TextDocument): ParsedCssBlock[] {
    const uri = document.uri.toString();
    const content = textOf(document);
    return zonesFor(document).cssBlocks.map(range => {
        const cssDoc = buildCssBodyDoc(uri, content, document.version, range);
        return { range, cssDoc, stylesheet: cssLanguageService().parseStylesheet(cssDoc) };
    });
}

/** Every <style> body on the page, parsed. Empty when there is no CSS. */
export function getParsedCssBlocks(document: vscode.TextDocument): ParsedCssBlock[] {
    return derivedFrom(document, parseBlocks);
}

/** The parsed <style> block holding `offset`, either end of its body included. */
export function getParsedCssBlockAt(document: vscode.TextDocument, offset: number): ParsedCssBlock | undefined {
    return getParsedCssBlocks(document).find(b => b.range.start <= offset && offset <= b.range.end);
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
