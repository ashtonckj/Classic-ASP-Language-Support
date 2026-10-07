import * as vscode from 'vscode';
import { getAspBlockRanges } from '../core/zoneUtils';

interface AspRegion {
    openingBracket: vscode.Range;
    codeBlock: vscode.Range;
    closingBracket: vscode.Range;
}

export interface AspRegionOffsets {
    open:  [number, number];
    code:  [number, number];
    close: [number, number];
}

/**
 * The <% … %> regions, from the same lexical scan as the zones (getAspBlockRanges):
 * each <% / <%= opener is paired with its FIRST %>, so a stray `%>` in plain HTML
 * text (e.g. inside "50%>") cannot shift the pairing of every real block after it.
 * A block still being typed, with no %> yet, is not tinted: it would tint the
 * rest of the page for as long as the %> is missing.
 */
export function findAspRegionOffsets(text: string): AspRegionOffsets[] {
    const regions: AspRegionOffsets[] = [];
    for (const block of getAspBlockRanges(text)) {
        if (block.end === Number.MAX_SAFE_INTEGER) { break; }
        const openEnd = block.start + (text[block.start + 2] === '=' ? 3 : 2);
        const close   = block.end - 2;
        regions.push({ open: [block.start, openEnd], code: [openEnd, close], close: [close, block.end] });
    }
    return regions;
}

export function getAspRegions(document: vscode.TextDocument): AspRegion[] {
    if (document.languageId !== 'asp') return [];

    const fullText = document.getText();
    return findAspRegionOffsets(fullText).map(r => ({
        openingBracket: new vscode.Range(document.positionAt(r.open[0]),  document.positionAt(r.open[1])),
        codeBlock:      new vscode.Range(document.positionAt(r.code[0]),  document.positionAt(r.code[1])),
        closingBracket: new vscode.Range(document.positionAt(r.close[0]), document.positionAt(r.close[1])),
    }));
}
