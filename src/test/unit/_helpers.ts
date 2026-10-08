/**
 * _helpers.ts
 *
 * Shared fakes for unit tests, so each test file does not grow its own.
 */

import * as vscode from 'vscode';

export interface FakeDocument extends vscode.TextDocument {
    /** Replaces the text and bumps the version, as an edit would. */
    setText(text: string): void;
    /** How many times getText() has been called. */
    readonly getTextCalls: number;
}

/**
 * A TextDocument over `text`: offsets and positions, lines, version, language
 * and URI. Lines split at `\n`; a `\r` before it stays at the end of the line,
 * as VS Code keeps it out of the line text but in the offsets.
 */
export function fakeDocument(
    text: string,
    options: { languageId?: string; fsPath?: string; uri?: vscode.Uri; eol?: vscode.EndOfLine } = {},
): FakeDocument {
    let current = text;
    let version = 1;
    let calls = 0;
    const lineStarts = () => {
        const starts = [0];
        for (let i = 0; i < current.length; i++) { if (current[i] === '\n') { starts.push(i + 1); } }
        return starts;
    };
    const fsPath = options.uri?.fsPath ?? options.fsPath ?? '/site/page.asp';

    const document = {
        get version() { return version; },
        get lineCount() { return lineStarts().length; },
        get getTextCalls() { return calls; },
        languageId: options.languageId ?? 'asp',
        eol: options.eol ?? 1,
        isClosed: false,
        uri: options.uri ?? { fsPath, scheme: 'file', toString: () => `file://${fsPath}` },
        fileName: fsPath,
        getText(range?: vscode.Range) {
            if (!range) { calls++; return current; }
            return current.slice(document.offsetAt(range.start), document.offsetAt(range.end));
        },
        offsetAt(position: vscode.Position) {
            const starts = lineStarts();
            const line = Math.min(position.line, starts.length - 1);
            return Math.min(starts[line] + position.character, current.length);
        },
        positionAt(offset: number) {
            const starts = lineStarts();
            let line = 0;
            while (line + 1 < starts.length && starts[line + 1] <= offset) { line++; }
            return new vscode.Position(line, offset - starts[line]);
        },
        lineAt(lineOrPosition: number | vscode.Position) {
            const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
            const starts = lineStarts();
            const end = line + 1 < starts.length ? starts[line + 1] - 1 : current.length;
            const lineText = current.slice(starts[line], end).replace(/\r$/, '');
            return { text: lineText, lineNumber: line };
        },
        setText(next: string) { current = next; version++; },
    };
    return document as unknown as FakeDocument;
}
