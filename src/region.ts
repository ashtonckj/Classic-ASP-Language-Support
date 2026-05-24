import * as vscode from "vscode";

/** Find opening and closing brackets for ASP code
 * 1) Opening tag
 * 2) Closing tag
 */
const ASP_BRACKETS = /(<%=|<%|%>)/g;

interface AspRegion {
    openingBracket: vscode.Range;
    codeBlock: vscode.Range;
    closingBracket: vscode.Range;
}

export function getAspRegions(document: vscode.TextDocument): AspRegion[] {
    if (document.languageId !== "asp") return [];

    const fullText = document.getText();
    const brackets: vscode.Range[] = [];
    let match: RegExpExecArray | null;

    while ((match = ASP_BRACKETS.exec(fullText)) !== null) {
        const startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + match[0].length);
        brackets.push(new vscode.Range(startPos, endPos));
    }

    const regions: AspRegion[] = [];
    for (let i = 0; i + 1 < brackets.length; i += 2) {
        const start = brackets[i];
        const end = brackets[i + 1];
        regions.push({
            openingBracket: start,
            codeBlock: new vscode.Range(start.end, end.start),
            closingBracket: end,
        });
    }

    return regions;
}
