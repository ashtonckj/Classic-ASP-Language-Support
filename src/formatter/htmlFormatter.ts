import * as vscode from 'vscode';
import * as prettier from 'prettier';
import { formatSingleAspBlock, getAspSettings, AspFormatterSettings } from './aspFormatter';

// Prettier settings interface
export interface PrettierSettings {
    printWidth: number;
    tabWidth: number;
    useTabs: boolean;
    semi: boolean;
    singleQuote: boolean;
    bracketSameLine: boolean;
    arrowParens: string;
    trailingComma: string;
    endOfLine: string;
    htmlWhitespaceSensitivity: string;
}

// Get Prettier settings from workspace config
export function getPrettierSettings(): PrettierSettings {
    const config = vscode.workspace.getConfiguration('aspLanguageSupport.prettier');
    return {
        printWidth: config.get<number>('printWidth', 80),
        tabWidth: config.get<number>('tabWidth', 2),
        useTabs: config.get<boolean>('useTabs', false),
        semi: config.get<boolean>('semi', true),
        singleQuote: config.get<boolean>('singleQuote', false),
        bracketSameLine: config.get<boolean>('bracketSameLine', true),
        arrowParens: config.get<string>('arrowParens', 'always'),
        trailingComma: config.get<string>('trailingComma', 'es5'),
        endOfLine: config.get<string>('endOfLine', 'lf'),
        htmlWhitespaceSensitivity: config.get<string>('htmlWhitespaceSensitivity', 'css')
    };
}

// Main function: Format complete ASP file
export async function formatCompleteAspFile(code: string): Promise<string> {
    const aspSettings = getAspSettings();
    const prettierSettings = getPrettierSettings();

    // Step 1: Extract and mask ASP blocks with unique identifiers
    const aspBlocks: { code: string; indent: string; id: string; lineNumber: number; isInline: boolean }[] = [];
    let blockCounter = 0;

    let maskedCode = code;

    maskedCode = code.replace(/([ \t]*)(<%[\s\S]*?%>)/g, (match, indent, aspBlock, offset) => {
        // Check if this ASP block is inside an HTML tag (between < and >)
        const beforeMatch = code.substring(0, offset);
        const lastOpenTag = beforeMatch.lastIndexOf('<');
        const lastCloseTag = beforeMatch.lastIndexOf('>');

        const isInsideTag = lastOpenTag > lastCloseTag;

        // Calculate line number
        const textBefore = code.substring(0, offset);
        const lineNumber = textBefore.split('\n').length - 1;

        const uniqueId = `ASP_PLACEHOLDER_${blockCounter}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        aspBlocks.push({
            code: aspBlock,
            indent: indent,
            id: uniqueId,
            lineNumber: lineNumber,
            isInline: isInsideTag
        });
        blockCounter++;

        // If inside tag, use a valid placeholder that won't break HTML parsing
        if (isInsideTag) {
            return `__${uniqueId}__`;
        } else {
            return indent + `<!--${uniqueId}-->`;
        }
    });

    // Step 2: Format HTML/CSS/JS with Prettier
    let prettifiedCode: string;
    try {
        const formatted = await prettier.format(maskedCode, {
            parser: 'html',
            printWidth: prettierSettings.printWidth,
            tabWidth: prettierSettings.tabWidth,
            useTabs: prettierSettings.useTabs,
            semi: prettierSettings.semi,
            singleQuote: prettierSettings.singleQuote,
            bracketSameLine: prettierSettings.bracketSameLine,
            arrowParens: prettierSettings.arrowParens as any,
            trailingComma: prettierSettings.trailingComma as any,
            endOfLine: prettierSettings.endOfLine as any,
            htmlWhitespaceSensitivity: prettierSettings.htmlWhitespaceSensitivity as any
        });
        prettifiedCode = formatted;
        prettifiedCode = fixClosingBrackets(prettifiedCode);
    } catch (error) {
        console.error('Prettier formatting failed:', error);
        prettifiedCode = maskedCode;
    }

    // Step 3: Separate single-line and multi-line blocks
    const singleLineBlocks: number[] = [];
    const multiLineBlocks: number[] = [];

    for (let i = 0; i < aspBlocks.length; i++) {
        const trimmed = aspBlocks[i].code.trim();
        if ((trimmed.startsWith('<%=') || trimmed.startsWith('<% =')) && !trimmed.includes('\n')) {
            singleLineBlocks.push(i);
        } else if (!trimmed.includes('\n')) {
            singleLineBlocks.push(i);
        } else {
            multiLineBlocks.push(i);
        }
    }

    const formattedBlocks: string[] = new Array(aspBlocks.length);

    // Format single-line blocks individually (but not inline ones)
    for (const i of singleLineBlocks) {
        if (aspBlocks[i].isInline) {
            // Don't format inline blocks - keep them as-is
            formattedBlocks[i] = aspBlocks[i].code;
        } else {
            formattedBlocks[i] = formatSingleAspBlock(aspBlocks[i].code, aspSettings, '', false);
        }
    }

    // Format multi-line blocks with context if they exist (skip inline ones)
    const multiLineNonInlineBlocks = multiLineBlocks.filter(i => !aspBlocks[i].isInline);

    if (multiLineNonInlineBlocks.length > 0) {
        // Format each multi-line block individually
        for (const i of multiLineNonInlineBlocks) {
            formattedBlocks[i] = formatSingleAspBlock(aspBlocks[i].code, aspSettings, '', false);
        }
    }

    // Handle inline multi-line blocks (shouldn't happen often, but just in case)
    for (const i of multiLineBlocks) {
        if (aspBlocks[i].isInline && !formattedBlocks[i]) {
            formattedBlocks[i] = aspBlocks[i].code;
        }
    }

    // Step 4: Restore each formatted block
    let restoredCode = prettifiedCode;

    for (let i = 0; i < aspBlocks.length; i++) {
        const block = aspBlocks[i];
        const formattedBlock = formattedBlocks[i];

        if (block.isInline) {
            // Simple replacement for inline blocks
            restoredCode = restoredCode.replace(`__${block.id}__`, formattedBlock);
        } else {
            // Escape special regex characters in the ID
            const escapedId = block.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Find the placeholder with its surrounding whitespace and indentation
            const placeholderPattern = `([ \\t]*)<!--${escapedId}-->`;
            const match = restoredCode.match(new RegExp(placeholderPattern));

            if (match) {
                const htmlIndent = match[1];

                // Add HTML indent to each line of the formatted block
                const indentedBlock = formattedBlock.split('\n').map(line => {
                    if (line.trim()) {
                        return htmlIndent + line;
                    }
                    return line;
                }).join('\n');

                // Replace the placeholder
                restoredCode = restoredCode.replace(
                    new RegExp(`[ \\t]*<!--${escapedId}-->`),
                    indentedBlock
                );
            } else {
                // Fallback: just replace without indent detection
                restoredCode = restoredCode.replace(
                    `<!--${block.id}-->`,
                    formattedBlock
                );
            }
        }
    }

    return restoredCode;
}

// Fix closing brackets
function fixClosingBrackets(code: string): string {
    return code.replace(/(<\/[^>]+)\n\s*>/g, '$1>');
}