import * as vscode from 'vscode';

// Settings interface
export interface AspFormatterSettings {
    keywordCase: string;
    useTabs: boolean;
    indentSize: number;
}

// Get ASP formatter settings
export function getAspSettings(): AspFormatterSettings {
    const config = vscode.workspace.getConfiguration('aspLanguageSupport');
    return {
        keywordCase: config.get<string>('keywordCase', 'PascalCase'),
        useTabs: config.get<boolean>('useTabs', false),
        indentSize: config.get<number>('indentSize', 2),
    };
}

// Format a single ASP block (either <% ... %> or <%= ... %>)
export function formatSingleAspBlock(block: string, settings: AspFormatterSettings, htmlIndent: string = '', continuesFromPrevious: boolean = false): string {
    // Check if it's an inline expression <%= %>
    const trimmedBlock = block.trim();
    if (trimmedBlock.startsWith('<%=') || trimmedBlock.startsWith('<% =')) {
        // Extract content - handle both <%= and <% =
        let content: string;
        if (trimmedBlock.startsWith('<%=')) {
            content = trimmedBlock.substring(3, trimmedBlock.length - 2).trim();
        } else {
            // <% = case - skip the space
            content = trimmedBlock.substring(4, trimmedBlock.length - 2).trim();
        }
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
    let inMultilineString = false;
    let preservedStringIndent = '';
    let sqlBaseIndent = 0; // Track the base indent for SQL strings
    let isInSQLBlock = false; // Track if we're in a SQL block

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const trimmedLine = line.trim();

        // Opening tag
        if (trimmedLine === '<%' || trimmedLine.startsWith('<%')) {
            if (trimmedLine === '<%') {
                formattedLines.push(htmlIndent + '<%');
                previousLineHadContinuation = false;
                isInSQLBlock = false;
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
                    inMultilineString = true;

                    // Check if this line starts a SQL block
                    if (isSQLStatement(formattedContent)) {
                        isInSQLBlock = true;
                        sqlBaseIndent = (htmlIndent + aspIndent).length;
                    }
                } else {
                    previousLineHadContinuation = false;
                    inMultilineString = false;
                    isInSQLBlock = false;
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
                inMultilineString = false;
                isInSQLBlock = false;
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
            inMultilineString = false;
            isInSQLBlock = false;
            continue;
        }

        // Handle empty lines within multiline strings
        if (!trimmedLine && inMultilineString) {
            // Preserve empty lines but don't reset continuation state
            formattedLines.push('');
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
                isInSQLBlock = false;
                continue;
            }

            // Check if this is a continuation line
            if (previousLineHadContinuation && trimmedLine.startsWith('"')) {
                const isSQLString = isInSQLBlock || isSQLStatement(trimmedLine);
                const formattedContent = isSQLString ? trimmedLine : applyKeywordCase(trimmedLine, settings.keywordCase);

                if (isSQLString) {
                    // Get the original indentation of this line
                    const originalIndent = line.substring(0, line.indexOf(line.trim()));
                    const originalIndentSize = originalIndent.length;

                    if (!isInSQLBlock) {
                        // First SQL line in continuation - set base indent and format with one tab from assignment
                        sqlBaseIndent = originalIndentSize;
                        isInSQLBlock = true;
                        const aspIndent = getIndentString(aspIndentLevel + 1, settings.useTabs, settings.indentSize);
                        formattedLines.push(htmlIndent + aspIndent + trimmedLine);
                    } else {
                        // Already in SQL block (either started here or on previous line with assignment)
                        const relativeIndent = originalIndentSize - sqlBaseIndent;
                        // If there's ANY indentation (even 1 space), use +1 tab. Otherwise use base.
                        const extraLevel = relativeIndent > 0 ? 1 : 0;

                        const aspIndent = getIndentString(aspIndentLevel + 1 + extraLevel, settings.useTabs, settings.indentSize);
                        formattedLines.push(htmlIndent + aspIndent + trimmedLine);
                    }
                } else {
                    // For non-SQL strings, use the calculated alignment
                    const alignIndent = ' '.repeat(continuationAlignColumn);
                    formattedLines.push(alignIndent + formattedContent);
                }

                const hasContinuation = formattedContent.trim().endsWith('_');
                if (!hasContinuation) {
                    previousLineHadContinuation = false;
                    inMultilineString = false;
                    isInSQLBlock = false;
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
                inMultilineString = true;

                // Check if this line starts a SQL block
                if (isSQLStatement(formattedContent)) {
                    isInSQLBlock = true;
                    // Set the base indent as the current line's indent (for next lines to compare against)
                    // Since this is the assignment line, continuation lines should be indented from HERE
                    sqlBaseIndent = (htmlIndent + aspIndent).length;
                }
            } else {
                previousLineHadContinuation = false;
                inMultilineString = false;
                isInSQLBlock = false;
            }

            formattedLines.push(htmlIndent + aspIndent + formattedContent);
            if (indentChange.after > 0) {
                aspIndentLevel += indentChange.after;
            }
        } else {
            formattedLines.push('');
            // Don't reset continuation state for empty lines
            if (!inMultilineString) {
                previousLineHadContinuation = false;
                isInSQLBlock = false;
            }
        }
    }

    return formattedLines.join('\n');
}

// Calculate where the next line should align for line continuation
function calculateContinuationColumn(line: string, htmlIndent: string, aspIndent: string): number {
    const fullIndent = htmlIndent + aspIndent;
    const trimmed = line.trim();

    // Find the position of the equals sign or opening quote
    const equalsPos = trimmed.indexOf('=');
    if (equalsPos !== -1) {
        // If there's an equals sign, find the opening quote after it
        const afterEquals = trimmed.substring(equalsPos + 1).trim();
        if (afterEquals.startsWith('"')) {
            // Align with the opening quote (not after it)
            const quoteOffset = trimmed.substring(equalsPos).indexOf('"');
            return fullIndent.length + equalsPos + quoteOffset;
        }
    }

    // If no equals sign or no quote after equals, align with first quote
    const quotePos = trimmed.indexOf('"');
    if (quotePos !== -1) {
        return fullIndent.length + quotePos;
    }

    // Default: align with underscore
    return fullIndent.length + trimmed.lastIndexOf('_');
}

// Get indent string (tabs or spaces)
function getIndentString(level: number, useTabs: boolean, indentSize: number): string {
    if (useTabs) {
        return '\t'.repeat(level);
    } else {
        return ' '.repeat(level * indentSize);
    }
}

// Apply keyword case
function applyKeywordCase(code: string, caseStyle: string): string {
    // Don't format if it's inside a string
    if (code.trim().startsWith('"')) {
        return code;
    }

    // Split by strings first
    const parts = splitByStrings(code);

    // Format each non-string part
    const formattedParts = parts.map(part => {
        if (part.isString) {
            return part.text;
        } else {
            // Format keywords and operators in non-string parts
            let formatted = formatKeywordsInText(part.text, caseStyle);
            formatted = formatOperators(formatted);
            formatted = formatCommas(formatted);
            return formatted;
        }
    });

    return formattedParts.join('');
}

// Format keywords in non-string text
function formatKeywordsInText(text: string, caseStyle: string): string {
    const keywords = [
        // Control structures
        'if', 'then', 'else', 'elseif', 'end if', 'select case', 'case', 'case else', 'end select',
        'for', 'to', 'step', 'next', 'for each', 'in', 'while', 'wend', 'do', 'loop', 'until', 'exit do', 'exit for',
        // Functions and subroutines
        'sub', 'end sub', 'function', 'end function', 'call', 'exit sub', 'exit function',
        // Variable declarations
        'dim', 'redim', 'preserve', 'const', 'private', 'public', 'static',
        // Object-oriented
        'class', 'end class', 'new', 'set', 'property get', 'property let', 'property set', 'end property',
        // Error handling
        'on error resume next', 'on error goto 0', 'err', 'error',
        // Logical operators
        'and', 'or', 'not', 'xor', 'eqv', 'imp',
        // Comparison
        'is', 'like',
        // Data types
        'nothing', 'null', 'empty', 'true', 'false',
        // Other
        'option explicit', 'randomize', 'with', 'end with', 'exit', 'mod', 'byval', 'byref',
        'default', 'erase', 'let', 'resume', 'stop', 'get', 'put', 'open', 'close', 'input',
        'output', 'append', 'binary', 'random', 'as', 'len', 'mid', 'left', 'right', 'ucase',
        'lcase', 'trim', 'ltrim', 'rtrim', 'replace', 'split', 'join', 'filter', 'instr',
        'instrrev', 'string', 'space', 'chr', 'asc', 'cint', 'clng', 'csng', 'cdbl', 'cdate',
        'cbool', 'cstr', 'cbyte', 'ccur', 'cvar', 'int', 'fix', 'abs', 'sgn', 'sqr', 'exp',
        'log', 'sin', 'cos', 'tan', 'atn', 'round', 'rnd', 'createobject', 'getobject',
        'msgbox', 'inputbox', 'isarray', 'isdate', 'isempty', 'isnull', 'isnumeric', 'isobject',
        'vartype', 'typename', 'ubound', 'lbound', 'array', 'date', 'time', 'now', 'timer',
        'dateserial', 'timeserial', 'datevalue', 'timevalue', 'year', 'month', 'day', 'weekday',
        'hour', 'minute', 'second', 'dateadd', 'datediff', 'datepart', 'formatdatetime',
        'formatnumber', 'formatcurrency', 'formatpercent', 'response', 'request', 'server',
        'session', 'application', 'write', 'redirect', 'querystring', 'form', 'servervariables',
        'cookies', 'mappath', 'createtextfile', 'opentextfile', 'writeline', 'readline',
        'readall', 'atendofstream', 'filesystemobject', 'scripting', 'dictionary', 'add',
        'exists', 'items', 'keys', 'remove', 'removeall', 'count', 'item', 'key'
    ];

    let result = text;

    // Sort keywords by length (longest first) to avoid partial replacements
    const sortedKeywords = keywords.sort((a, b) => b.length - a.length);

    for (const keyword of sortedKeywords) {
        const regex = new RegExp('\\b' + keyword.replace(/\s+/g, '\\s+') + '\\b', 'gi');
        result = result.replace(regex, (match) => formatKeyword(match, caseStyle));
    }

    return result;
}

// Split code by strings (to avoid formatting inside strings)
function splitByStrings(code: string): Array<{text: string, isString: boolean}> {
    const parts: Array<{text: string, isString: boolean}> = [];
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
                parts.push({text: current, isString: true});
                current = '';
                inString = false;
            } else {
                // Starting string
                if (current) {
                    parts.push({text: current, isString: false});
                }
                current = char;
                inString = true;
            }
        } else {
            current += char;
        }
    }

    if (current) {
        parts.push({text: current, isString: inString});
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

// Format commas - add space after commas outside strings
function formatCommas(code: string): string {
    // Split by strings, format only non-string parts
    const stringParts = splitByStrings(code);
    const result = stringParts.map(part => {
        if (!part.isString) {
            // Not in string, add space after commas
            return part.text.replace(/,(?!\s)/g, ', ');
        } else {
            // Inside string, keep as-is
            return part.text;
        }
    }).join('');

    return result;
}

// Check if a line is part of a SQL statement
function isSQLStatement(line: string): boolean {
    const trimmed = line.trim();
    // Check if it's a string that contains SQL keywords
    const sqlKeywords = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|ORDER BY|GROUP BY|UNION|CREATE|DROP|ALTER|AND|OR|ON|INNER|LEFT|RIGHT|OUTER|HAVING|DISTINCT|TOP|AS|LIKE|BETWEEN|IN|EXISTS|CASE|WHEN|THEN|ELSE|END|SET|VALUES|INTO)\b/i;
    return sqlKeywords.test(trimmed);
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