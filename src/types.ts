import * as vscode from "vscode";

export interface AspRegion {
    openingBracket: vscode.Range;
    codeBlock: vscode.Range;
    closingBracket: vscode.Range;
}
