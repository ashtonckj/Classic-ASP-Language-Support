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

/**
 * Returns true when `offset` falls inside a <% ... %> ASP block.
 *
 * Naive lastIndexOf('%>') breaks when a VBScript comment contains %>:
 *   ' HOW TO USE: %> tag placement.   ← looks like a close tag but isn't
 *
 * This implementation scans the text character-by-character, tracking open/
 * close pairs.  When inside an ASP block it processes the content line by
 * line: any line whose first non-whitespace character is a VBScript comment
 * marker (') is skipped entirely so that %> inside comments is invisible.
 */
export function isInsideAspBlock(text: string, offset: number): boolean {
    let i = 0;
    let inAsp = false;

    while (i < text.length) {
        if (!inAsp) {
            // Advance through HTML comments first — any <% inside <!-- --> is not real.
            if (text.slice(i, i + 4) === '<!--') {
                const closeIdx = text.indexOf('-->', i + 4);
                // If offset is inside this HTML comment, it is NOT in an ASP block.
                if (closeIdx === -1 || offset < closeIdx + 3) { return false; }
                i = closeIdx + 3;
                continue;
            }

            // Outside ASP — find next <% but skip over any HTML comments on the way.
            const openIdx = text.indexOf('<%', i);
            if (openIdx === -1) { return false; }      // no more ASP blocks
            if (openIdx >= offset) { return false; }   // offset is before any ASP open

            // Check if the <% we found is inside an HTML comment by scanning
            // from i to openIdx for any <!-- that doesn't close before openIdx.
            const commentStart = text.indexOf('<!--', i);
            if (commentStart !== -1 && commentStart < openIdx) {
                // There is an HTML comment that starts before this <%.
                // Jump past the comment and retry — don't treat this <% as real.
                const commentEnd = text.indexOf('-->', commentStart + 4);
                if (commentEnd === -1 || offset <= commentEnd + 2) { return false; }
                i = commentEnd + 3;
                continue;
            }

            inAsp = true;
            i = openIdx + 2;                           // move past <%
        } else {
            // Inside ASP — scan the current line character by character.
            //
            // Rules (matching real ASP/VBScript behaviour):
            //   "..."  — string literal: %> and ' inside are not special
            //   '      — VBScript inline comment: everything from here to EOL
            //            is a comment, so %> after the ' does NOT close the block
            //   %>     — outside a string and before any ', closes the ASP block
            //
            // This correctly handles all three cases:
            //   <% 'comment %>       → %> closes the block
            //   <% code 'comment %>  → %> closes the block
            //   ' whole-line comment → treated the same; %> in the comment is ignored
            //
            // A <% that appears inside a VBScript comment ('... <%...) is harmless
            // because the scanner is already inside the ASP block and only ever looks
            // for %> (not for a new <%).
            const lineStart = i;
            const lineEnd   = text.indexOf('\n', i);
            const end       = lineEnd === -1 ? text.length : lineEnd + 1;

            let j     = lineStart;
            let inStr = false;

            while (j < end) {
                const ch = text[j];

                if (inStr) {
                    if (ch === '"') {
                        if (j + 1 < end && text[j + 1] === '"') { j += 2; continue; } // escaped ""
                        inStr = false;
                    }
                    j++;
                    continue;
                }

                if (ch === '"') { inStr = true; j++; continue; }

                // VBScript inline comment — the rest of this line is comment text,
                // but %> still closes the ASP block (tag delimiters are parsed at
                // the HTML level, before VBScript runs). Keep scanning for %>.
                if (ch === "'") {
                    while (j < end) {
                        if (text[j] === '%' && text[j + 1] === '>') {
                            const closeEnd = j + 2;
                            if (offset < closeEnd) {
                                return offset > (text.lastIndexOf('<%', j));
                            }
                            inAsp = false;
                            i = closeEnd;
                            break;
                        }
                        j++;
                    }
                    // Whether or not we found %>, we are done with this line
                    if (inAsp) {
                        i = end;
                        if (offset < end) { return true; }
                    }
                    break;
                }

                if (ch === '%' && text[j + 1] === '>') {
                    const closeEnd = j + 2;
                    if (offset < closeEnd) {
                        return offset > (text.lastIndexOf('<%', j));
                    }
                    inAsp = false;
                    i = closeEnd;
                    break;
                }

                j++;
            }

            if (inAsp) {
                // Reached end of line without finding %> or ' → keep scanning
                i = end;
                if (offset < end) { return true; }
            }
        }
    }

    return false;
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