import * as vscode from 'vscode';

// Settings interface
export interface AspFormatterSettings {
    keywordCase: string;
    useTabs: boolean;
    indentSize: number;
}

// Get ASP formatter settings
export function getAspSettings(): AspFormatterSettings {
    const config = vscode.workspace.getConfiguration('aspFormatter');
    return {
        keywordCase: config.get<string>('keywordCase', 'PascalCase'),
        useTabs: config.get<boolean>('useTabs', false),
        indentSize: config.get<number>('indentSize', 2),
    };
}

// Format a single ASP block (either <% ... %> or <%= ... %>)
export function formatSingleAspBlock(block: string, settings: AspFormatterSettings, htmlIndent: string = '', continuesFromPrevious: boolean = false): string {
    // Check if it's an inline expression <%= %>
    if (block.trim().startsWith('<%=')) {
        const content = block.substring(3, block.length - 2).trim();
        const formattedContent = applyKeywordCase(content, settings.keywordCase);
        return htmlIndent + '<%= ' + formattedContent + ' %>';
    }
    
    // Check if it's a single-line block
    if (!block.includes('\n')) {
        const content = block.substring(2, block.length - 2).trim();
        const formattedContent = applyKeywordCase(content, settings.keywordCase);
        return htmlIndent + '<% ' + formattedContent + ' %>';
    }
    
    // Multi-line block: format with indentation
    return formatMultiLineAspBlock(block, settings, htmlIndent, continuesFromPrevious);
}

// Format multi-line ASP block
function formatMultiLineAspBlock(block: string, settings: AspFormatterSettings, htmlIndent: string = '', continuesFromPrevious: boolean = false): string {
    const lines = block.split('\n');
    const formattedLines: string[] = [];
    let aspIndentLevel = 0;
    let previousLineHadContinuation = false;
    let continuationAlignColumn = 0;
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const trimmedLine = line.trim();
        
        // Opening tag
        if (trimmedLine === '<%' || trimmedLine.startsWith('<%')) {
            if (trimmedLine === '<%') {
                formattedLines.push(htmlIndent + '<%');
                previousLineHadContinuation = false;
                continue;
            }
            const content = trimmedLine.substring(2).trim();
            if (content) {
                const indentChange = getIndentChange(content);
                
                if (continuesFromPrevious && i === 0 && /^(else|elseif|end\s+if|loop|wend|next)/i.test(content)) {
                    aspIndentLevel = Math.max(0, aspIndentLevel);
                } else if (indentChange.before < 0) {
                    aspIndentLevel = Math.max(0, aspIndentLevel + indentChange.before);
                }
                
                const aspIndent = getIndentString(aspIndentLevel, settings.useTabs, settings.indentSize);
                const formattedContent = applyKeywordCase(content, settings.keywordCase);
                
                // Check for line continuation
                const hasContinuation = formattedContent.trim().endsWith('_');
                if (hasContinuation) {
                    continuationAlignColumn = calculateContinuationColumn(formattedContent, htmlIndent, aspIndent);
                    previousLineHadContinuation = true;
                } else {
                    previousLineHadContinuation = false;
                }
                
                formattedLines.push(htmlIndent + aspIndent + formattedContent);
                if (indentChange.after > 0) {
                    aspIndentLevel += indentChange.after;
                }
            }
            continue;
        }
        
        // Closing tag
        if (trimmedLine === '%>' || trimmedLine.endsWith('%>')) {
            if (trimmedLine === '%>') {
                formattedLines.push(htmlIndent + '%>');
                previousLineHadContinuation = false;
                continue;
            }
            const content = trimmedLine.substring(0, trimmedLine.length - 2).trim();
            if (content) {
                const indentChange = getIndentChange(content);
                if (indentChange.before < 0) {
                    aspIndentLevel = Math.max(0, aspIndentLevel + indentChange.before);
                }
                const aspIndent = getIndentString(aspIndentLevel, settings.useTabs, settings.indentSize);
                const formattedContent = applyKeywordCase(content, settings.keywordCase);
                formattedLines.push(htmlIndent + aspIndent + formattedContent);
                if (indentChange.after > 0) {
                    aspIndentLevel += indentChange.after;
                }
            }
            formattedLines.push(htmlIndent + '%>');
            previousLineHadContinuation = false;
            continue;
        }
        
        // Regular line inside ASP block
        if (trimmedLine) {
            // Special handling for comments
            if (trimmedLine.startsWith("'")) {
                // Look ahead to see what's on the next line
                const nextLineIndex = i + 1;
                let commentIndent = htmlIndent;
                
                if (nextLineIndex < lines.length) {
                    const nextLine = lines[nextLineIndex].trim();
                    
                    // If next line is not empty and not another comment, inherit its indent
                    if (nextLine && !nextLine.startsWith("'") && nextLine !== '%>') {
                        // Calculate what the next line's indent will be
                        const nextIndentChange = getIndentChange(nextLine);
                        let nextAspIndentLevel = aspIndentLevel;
                        
                        if (nextIndentChange.before < 0) {
                            nextAspIndentLevel = Math.max(0, nextAspIndentLevel + nextIndentChange.before);
                        }
                        
                        commentIndent = htmlIndent + getIndentString(nextAspIndentLevel, settings.useTabs, settings.indentSize);
                    } else {
                        // Next line is empty or another comment, keep current indent
                        commentIndent = htmlIndent + getIndentString(aspIndentLevel, settings.useTabs, settings.indentSize);
                    }
                } else {
                    // No next line, keep current indent
                    commentIndent = htmlIndent + getIndentString(aspIndentLevel, settings.useTabs, settings.indentSize);
                }
                
                formattedLines.push(commentIndent + trimmedLine);
                previousLineHadContinuation = false;
                continue;
            }
            
            // Check if this is a continuation line
            if (previousLineHadContinuation && trimmedLine.startsWith('"')) {
                const alignIndent = ' '.repeat(continuationAlignColumn);
                const formattedContent = applyKeywordCase(trimmedLine, settings.keywordCase);
                formattedLines.push(alignIndent + formattedContent);
                
                const hasContinuation = formattedContent.trim().endsWith('_');
                if (!hasContinuation) {
                    previousLineHadContinuation = false;
                }
                continue;
            }
            
            const indentChange = getIndentChange(trimmedLine);
            
            if (continuesFromPrevious && i === 0 && /^(else|elseif|end\s+if|loop|wend|next)/i.test(trimmedLine)) {
                aspIndentLevel = Math.max(0, aspIndentLevel);
            } else if (indentChange.before < 0) {
                aspIndentLevel = Math.max(0, aspIndentLevel + indentChange.before);
            }
            
            const aspIndent = getIndentString(aspIndentLevel, settings.useTabs, settings.indentSize);
            const formattedContent = applyKeywordCase(trimmedLine, settings.keywordCase);
            
            // Check for line continuation
            const hasContinuation = formattedContent.trim().endsWith('_');
            if (hasContinuation) {
                continuationAlignColumn = calculateContinuationColumn(formattedContent, htmlIndent, aspIndent);
                previousLineHadContinuation = true;
            } else {
                previousLineHadContinuation = false;
            }
            
            formattedLines.push(htmlIndent + aspIndent + formattedContent);
            if (indentChange.after > 0) {
                aspIndentLevel += indentChange.after;
            }
        } else {
            formattedLines.push('');
            previousLineHadContinuation = false;
        }
    }
    
    return formattedLines.join('\n');
}

// Calculate where the next line should align for line continuation
function calculateContinuationColumn(line: string, htmlIndent: string, aspIndent: string): number {
    const fullIndent = htmlIndent + aspIndent;
    const trimmed = line.trim();
    
    // Pattern: variable = _ (continuation only)
    // Next line should be: one tab more than variable
    const continuationOnlyMatch = trimmed.match(/^[^=]+=\s*_$/);
    if (continuationOnlyMatch) {
        const tabSize = aspIndent.includes('\t') ? 1 : (aspIndent.match(/  /g) || []).length * 2;
        const useTab = aspIndent.includes('\t');
        const extraIndent = useTab ? '\t' : '  ';
        return fullIndent.length + extraIndent.length;
    }
    
    // Pattern: variable = "..." & _ 
    // Next line quote should align with first quote
    const assignmentMatch = trimmed.match(/^[^=]+=\s*"/);
    if (assignmentMatch) {
        const quotePos = line.indexOf('"');
        return quotePos;
    }
    
    // Pattern: "..." & _ (continuation of concatenation)
    // Next line quote should align with previous quote
    const concatenationMatch = trimmed.match(/^"[^"]*"\s*&\s*_$/);
    if (concatenationMatch) {
        const firstQuotePos = line.indexOf('"');
        return firstQuotePos;
    }
    
    // Default: one tab more than current indent
    const tabSize = aspIndent.includes('\t') ? 1 : 2;
    const extraIndent = aspIndent.includes('\t') ? '\t' : '  ';
    return fullIndent.length + extraIndent.length;
}

// Generate indent string
function getIndentString(level: number, useTabs: boolean, size: number): string {
    if (useTabs) {
        return '\t'.repeat(level);
    } else {
        return ' '.repeat(level * size);
    }
}

// Apply keyword case formatting
function applyKeywordCase(code: string, caseStyle: string): string {
    // Don't format if entire line is a comment
    if (code.trim().startsWith("'")) {
        return code;
    }
    
    // Split by comments first, only format the non-comment part
    const commentIndex = code.indexOf("'");
    let codeToFormat = code;
    let comment = "";
    
    if (commentIndex !== -1) {
        // Check if the ' is inside a string
        const beforeComment = code.substring(0, commentIndex);
        const quoteCount = (beforeComment.match(/"/g) || []).length;
        
        // If odd number of quotes before ', it's inside a string, so don't split
        if (quoteCount % 2 === 0) {
            codeToFormat = code.substring(0, commentIndex);
            comment = code.substring(commentIndex);
        }
    }
    
    const keywords = [
        'if', 'then', 'else', 'elseif', 'end if',
        'for', 'to', 'step', 'next', 'each', 'in',
        'while', 'wend', 'do', 'loop', 'until',
        'select', 'case', 'end select',
        'dim', 'redim', 'const', 'private', 'public',
        'sub', 'end sub', 'function', 'end function', 'call', 'exit',
        'property', 'get', 'let', 'set', 'end property',
        'class', 'end class', 'new',
        'with', 'end with', 'option', 'explicit',
        'on', 'error', 'resume', 'goto',
        'and', 'or', 'not', 'xor', 'eqv', 'imp',
        'is', 'mod', 'true', 'false', 'null', 'nothing', 'empty'
    ];
    
    const aspObjects = [
        'response', 'request', 'server', 'session', 'application',
        'write', 'redirect', 'end', 'form', 'querystring', 'cookies',
        'servervariables', 'mappath', 'createobject', 'htmlencode', 'urlencode'
    ];

    let result = codeToFormat;
    
    // Format keywords only outside strings
    for (const keyword of keywords) {
        result = formatKeywordOutsideStrings(result, keyword, caseStyle);
    }
    
    // Format ASP objects in PascalCase only outside strings
    for (const obj of aspObjects) {
        result = formatKeywordOutsideStrings(result, obj, 'PascalCase');
    }
    
    // Format operators only outside strings
    result = formatOperators(result);
    
    return result + comment;
}

// Format keyword only when it's outside strings
function formatKeywordOutsideStrings(code: string, keyword: string, caseStyle: string): string {
    const parts: string[] = [];
    let currentPos = 0;
    let inString = false;
    
    for (let i = 0; i < code.length; i++) {
        const char = code[i];
        
        if (char === '"') {
            // Check if it's escaped (double quotes)
            if (i + 1 < code.length && code[i + 1] === '"') {
                i++; // Skip the escaped quote
                continue;
            }
            inString = !inString;
        }
        
        // Only match keywords when not in string
        if (!inString && i === currentPos) {
            const remaining = code.substring(i);
            const regex = new RegExp('^\\b' + keyword + '\\b', 'i');
            const match = remaining.match(regex);
            
            if (match) {
                parts.push(formatKeyword(keyword, caseStyle));
                currentPos = i + match[0].length;
                i = currentPos - 1;
                continue;
            }
        }
    }
    
    // If no matches found, try simple replace outside strings
    const regex = new RegExp('\\b' + keyword + '\\b', 'gi');
    let result = '';
    let lastIndex = 0;
    inString = false;
    
    for (let i = 0; i < code.length; i++) {
        if (code[i] === '"') {
            if (i + 1 < code.length && code[i + 1] === '"') {
                i++;
                continue;
            }
            inString = !inString;
        }
    }
    
    // Use a different approach: split by strings, format each part
    const stringParts = splitByStrings(code);
    result = stringParts.map((part, index) => {
        if (index % 2 === 0) {
            // Not in string, format it
            return part.replace(regex, (match) => formatKeyword(keyword, caseStyle));
        } else {
            // Inside string, keep as-is
            return part;
        }
    }).join('');
    
    return result;
}

// Split code by strings, returning array of [nonString, string, nonString, string, ...]
function splitByStrings(code: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inString = false;
    
    for (let i = 0; i < code.length; i++) {
        const char = code[i];
        
        if (char === '"') {
            // Check for escaped quote
            if (i + 1 < code.length && code[i + 1] === '"') {
                current += '""';
                i++;
                continue;
            }
            
            if (inString) {
                // Ending string
                current += char;
                parts.push(current);
                current = '';
                inString = false;
            } else {
                // Starting string
                if (current) {
                    parts.push(current);
                }
                current = char;
                inString = true;
            }
        } else {
            current += char;
        }
    }
    
    if (current) {
        parts.push(current);
    }
    
    return parts;
}

// Format keyword
function formatKeyword(keyword: string, caseStyle: string): string {
    switch (caseStyle) {
        case 'lowercase':
            return keyword.toLowerCase();
        case 'UPPERCASE':
            return keyword.toUpperCase();
        case 'PascalCase':
            return keyword.split(' ').map(word => 
                word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
            ).join(' ');
        default:
            return keyword;
    }
}

// Format operators
function formatOperators(code: string): string {
    // Don't format operators inside strings
    // Split by strings, format only non-string parts
    const parts: string[] = [];
    let currentPos = 0;
    let inString = false;
    let stringChar = '';
    
    for (let i = 0; i < code.length; i++) {
        const char = code[i];
        
        if (!inString && char === '"') {
            // Entering string
            if (currentPos < i) {
                // Format the non-string part
                parts.push(formatOperatorsInText(code.substring(currentPos, i)));
            }
            inString = true;
            stringChar = '"';
            currentPos = i;
        } else if (inString && char === stringChar) {
            // Check if it's escaped (double quotes in VBScript)
            if (i + 1 < code.length && code[i + 1] === stringChar) {
                // Escaped quote, skip
                i++;
                continue;
            }
            // Exiting string
            parts.push(code.substring(currentPos, i + 1));
            inString = false;
            currentPos = i + 1;
        }
    }
    
    // Add remaining part
    if (currentPos < code.length) {
        if (inString) {
            parts.push(code.substring(currentPos));
        } else {
            parts.push(formatOperatorsInText(code.substring(currentPos)));
        }
    }
    
    return parts.join('');
}

// Actually format operators in non-string text
function formatOperatorsInText(text: string): string {
    const operators = [
        { pattern: /\s*=\s*/g, replacement: ' = ' },
        { pattern: /\s*<>\s*/g, replacement: ' <> ' },
        { pattern: /\s*\+\s*/g, replacement: ' + ' },
        { pattern: /\s*-\s*/g, replacement: ' - ' },
        { pattern: /\s*\*\s*/g, replacement: ' * ' },
        { pattern: /\s*\/\s*/g, replacement: ' / ' },
        { pattern: /\s*&\s*/g, replacement: ' & ' },
        { pattern: /\s*<\s*/g, replacement: ' < ' },
        { pattern: /\s*>\s*/g, replacement: ' > ' },
        { pattern: /\s*<=\s*/g, replacement: ' <= ' },
        { pattern: /\s*>=\s*/g, replacement: ' >= ' }
    ];
    
    let result = text;
    
    for (const op of operators) {
        result = result.replace(op.pattern, op.replacement);
    }
    
    result = result.replace(/ < > /g, ' <> ');
    result = result.replace(/ < = /g, ' <= ');
    result = result.replace(/ > = /g, ' >= ');
    
    return result;
}

// Get indent change
function getIndentChange(line: string): { before: number; after: number } {
    const lowerLine = line.toLowerCase().trim();
    
    if (/\bif\b.*\bthen\b\s+\S+/.test(lowerLine)) {
        return { before: 0, after: 0 };
    }
    
    const decreaseBeforePatterns = [
        /^\s*end\s+(if|sub|function|with|select|class|property)/,
        /^\s*loop(\s|$)/,
        /^\s*next(\s|$)/,
        /^\s*wend(\s|$)/,
        /^\s*else(\s|$)/,
        /^\s*elseif\s+/,
        /^\s*case\s+/,
        /^\s*case\s+else(\s|$)/
    ];
    
    const increaseAfterPatterns = [
        /\bif\b.*\bthen\b/,
        /\bfor\b\s+\w+\s*=/,
        /\bfor\s+each\b/,
        /\bwhile\b/,
        /\bdo\b(\s+while|\s+until)?(\s|$)/,
        /\bselect\s+case\b/,
        /\bsub\b\s+\w+/,
        /\bfunction\b\s+\w+/,
        /\bwith\b/,
        /\bclass\b\s+\w+/,
        /\bproperty\s+(get|let|set)\b/,
        /^\s*else(\s|$)/,
        /^\s*elseif\s+.*\bthen\b/,
        /^\s*case\s+/,
        /^\s*case\s+else(\s|$)/
    ];
    
    let before = 0;
    let after = 0;
    
    for (const pattern of decreaseBeforePatterns) {
        if (pattern.test(lowerLine)) {
            before = -1;
            break;
        }
    }
    
    for (const pattern of increaseAfterPatterns) {
        if (pattern.test(lowerLine)) {
            after = 1;
            break;
        }
    }
    
    return { before, after };
}