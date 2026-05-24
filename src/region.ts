import * as vscode from "vscode";
import { ASP_BRACKETS } from "./patterns";

export interface AspRegion {
    openingBracket: vscode.Range;
    codeBlock: vscode.Range;
    closingBracket: vscode.Range;
}

export function getAspRegions(document: vscode.TextDocument): AspRegion[] {
    // If we're not in an ASP context, no need to decorate
    if (document.languageId != "asp") {
        return [];
    }

    const fullText = document.getText();
    // const brackets: DecorationOptions[] = [];
    const brackets: vscode.Range[] = [];

    let match: RegExpExecArray | null;

    while ((match = ASP_BRACKETS.exec(fullText)) !== null) {
        // Bracket start
        const startPos = document.positionAt(match.index);

        // Bracket end
        const endPos = document.positionAt(match.index + match[0].length);

        // const decoration = { range: new Range(startPos, endPos) };

        brackets.push(new vscode.Range(startPos, endPos));
    }

    let index = 0;
    let max = brackets.length;

    const aspRegions: AspRegion[] = [];

    brackets.forEach(() => {
        if (index + 1 < max) {
            const start = brackets[index];
            const end = brackets[index + 1];
            const block = new vscode.Range(start.end, end.start);

            aspRegions.push({
                openingBracket: start,
                codeBlock: block,
                closingBracket: end,
            });
        }

        index += 2;
    });

    return aspRegions;
}
