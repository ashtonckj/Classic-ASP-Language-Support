import * as vscode from 'vscode';

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
 * Lexical scan of <% … %> regions, matching the ASP engine (and isInsideAspBlock):
 * each <% / <%= opener is paired with its FIRST %>. A stray `%>` sitting in plain
 * HTML text (e.g. inside "50%>") is NOT an opener, so — unlike the old
 * blind "pair every bracket two at a time" logic — it can no longer shift the
 * pairing of every real block after it.
 */
export function findAspRegionOffsets(text: string): AspRegionOffsets[] {
    const regions: AspRegionOffsets[] = [];
    const opener = /<%=?/g;
    let m: RegExpExecArray | null;

    while ((m = opener.exec(text)) !== null) {
        const openStart = m.index;
        const openEnd   = m.index + m[0].length;
        const close     = text.indexOf('%>', openEnd);
        if (close === -1) { break; } // unterminated block — no more regions
        const closeEnd  = close + 2;
        regions.push({ open: [openStart, openEnd], code: [openEnd, close], close: [close, closeEnd] });
        opener.lastIndex = closeEnd; // resume after this block's %>
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
