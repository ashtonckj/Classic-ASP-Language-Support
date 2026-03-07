import * as vscode from 'vscode';

export enum ContextType {
    HTML,
    CSS,
    JAVASCRIPT,
    ASP,
    UNKNOWN
}

// Determine what context the cursor is in
export function getContext(document: vscode.TextDocument, position: vscode.Position): ContextType {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // Check if inside ASP block <% ... %>
    if (isInsideAspBlock(text, offset)) {
        return ContextType.ASP;
    }

    // Check if inside <style> tag
    if (isInsideTag(text, offset, 'style')) {
        return ContextType.CSS;
    }

    // Check if inside <script> tag
    if (isInsideTag(text, offset, 'script')) {
        return ContextType.JAVASCRIPT;
    }

    // Default to HTML
    return ContextType.HTML;
}

// Check if cursor is inside ASP block
export function isInsideAspBlock(text: string, offset: number): boolean {
    const beforeCursor = text.substring(0, offset);
    const afterCursor = text.substring(offset);

    const lastOpen = beforeCursor.lastIndexOf('<%');
    const lastClose = beforeCursor.lastIndexOf('%>');
    const nextClose = afterCursor.indexOf('%>');

    return lastOpen > lastClose && nextClose !== -1;
}

// Check if cursor is inside a specific HTML tag
export function isInsideTag(text: string, offset: number, tagName: string): boolean {
    const beforeCursor = text.substring(0, offset);
    const afterCursor = text.substring(offset);

    const openTagRegex = new RegExp(`<${tagName}[^>]*>`, 'gi');
    const closeTagRegex = new RegExp(`</${tagName}>`, 'gi');

    let openMatches = 0;
    let closeMatches = 0;

    let match;
    while ((match = openTagRegex.exec(beforeCursor)) !== null) {
        openMatches++;
    }

    while ((match = closeTagRegex.exec(beforeCursor)) !== null) {
        closeMatches++;
    }

    if (openMatches > closeMatches) {
        // Check if there's a closing tag after cursor
        const nextClose = afterCursor.search(closeTagRegex);
        return nextClose !== -1;
    }

    return false;
}

/**
 * Replaces every <%...%> block in a string with an equal-length run of spaces.
 * This preserves character offsets so that lastIndexOf / indexOf results remain
 * valid, while preventing <% and %> from being mistaken for HTML brackets.
 */
function stripAspBlocks(text: string): string {
    return text.replace(/<%[\s\S]*?%>/g, match => ' '.repeat(match.length));
}

// Get the current tag name at cursor position
export function getCurrentTagName(document: vscode.TextDocument, position: vscode.Position): string | null {
    const text = document.getText();
    const offset = document.offsetAt(position);
    // Strip ASP blocks so that <% and %> are never mistaken for HTML brackets
    const beforeCursor = stripAspBlocks(text.substring(0, offset));

    // Look for the last < before cursor
    const lastOpenBracket = beforeCursor.lastIndexOf('<');
    if (lastOpenBracket === -1) {
        return null;
    }

    // Check if we're still inside the tag (haven't closed it yet)
    const textAfterBracket = beforeCursor.substring(lastOpenBracket);
    const hasClosingBracket = textAfterBracket.includes('>');

    if (hasClosingBracket) {
        return null;
    }

    // Extract tag name from original (un-stripped) text at the same offset
    const originalAfterBracket = text.substring(0, offset).substring(lastOpenBracket);
    const tagMatch = originalAfterBracket.match(/^<\/?(\w+)/);
    if (tagMatch) {
        return tagMatch[1];
    }

    return null;
}

// Check if cursor is right after '<' for tag completion
export function isAfterOpenBracket(document: vscode.TextDocument, position: vscode.Position): boolean {
    const lineText = document.lineAt(position.line).text;
    const charBeforeCursor = lineText.charAt(position.character - 1);
    return charBeforeCursor === '<';
}

// Check if cursor is inside a tag for attribute completion
export function isInsideTagForAttributes(document: vscode.TextDocument, position: vscode.Position): boolean {
    const text = document.getText();
    const offset = document.offsetAt(position);
    // Strip ASP blocks so <%...%> brackets are invisible to the HTML bracket scan
    const beforeCursor = stripAspBlocks(text.substring(0, offset));

    const lastOpenBracket = beforeCursor.lastIndexOf('<');
    const lastCloseBracket = beforeCursor.lastIndexOf('>');

    // We're inside a tag if the last < is after the last >
    return lastOpenBracket > lastCloseBracket;
}

// Get line text before cursor
export function getTextBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    const line = document.lineAt(position.line);
    return line.text.substring(0, position.character);
}

// Get word at position
export function getWordAtPosition(document: vscode.TextDocument, position: vscode.Position): string {
    const range = document.getWordRangeAtPosition(position);
    if (range) {
        return document.getText(range);
    }
    return '';
}