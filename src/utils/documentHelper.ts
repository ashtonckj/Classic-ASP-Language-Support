import * as vscode from 'vscode';

export enum ContextType {
    HTML,
    CSS,
    JS,
    ASP
}

/**
 * Determines the context at the cursor position
 */
export function getContext(document: vscode.TextDocument, position: vscode.Position): ContextType {
    // Check if we're inside <% %> block
    if (isInsideAspBlock(document, position)) {
        return ContextType.ASP;
    }

    // Check if inside <style> tag
    if (isInsideTag(document, position, 'style')) {
        return ContextType.CSS;
    }

    // Check if inside <script> tag
    if (isInsideTag(document, position, 'script')) {
        return ContextType.JS;
    }

    // Default to HTML
    return ContextType.HTML;
}

/**
 * Checks if cursor is inside <% %> block
 */
function isInsideAspBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
    // Get all text from start of document to cursor position
    const textBeforeCursor = document.getText(
        new vscode.Range(new vscode.Position(0, 0), position)
    );

    // Count opening <% tags
    const openTags = (textBeforeCursor.match(/<%/g) || []).length;

    // Count closing %> tags
    const closeTags = (textBeforeCursor.match(/%>/g) || []).length;

    // If more opening than closing, we're inside a block
    return openTags > closeTags;
}

/**
 * Checks if cursor is inside a specific HTML tag
 */
function isInsideTag(document: vscode.TextDocument, position: vscode.Position, tagName: string): boolean {
    const textBeforeCursor = document.getText(
        new vscode.Range(new vscode.Position(0, 0), position)
    );

    const openTagPattern = new RegExp(`<${tagName}[^>]*>`, 'gi');
    const closeTagPattern = new RegExp(`</${tagName}>`, 'gi');

    const openTags = (textBeforeCursor.match(openTagPattern) || []).length;
    const closeTags = (textBeforeCursor.match(closeTagPattern) || []).length;

    return openTags > closeTags;
}

/**
 * Gets text before cursor on current line
 */
export function getTextBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    const lineText = document.lineAt(position.line).text;
    return lineText.substring(0, position.character);
}