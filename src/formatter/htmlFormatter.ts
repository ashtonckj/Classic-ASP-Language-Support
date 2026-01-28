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
    const config = vscode.workspace.getConfiguration('aspFormatter.prettier');
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
    const aspBlocks: { code: string; indent: string; id: string; lineNumber: number }[] = [];
    let blockCounter = 0;
    
    const lines = code.split('\n');
    let maskedCode = code;
    
    // Track line numbers for context awareness
    let currentLine = 0;
    maskedCode = code.replace(/^([ \t]*)(<%[\s\S]*?%>)/gm, (match, indent, aspBlock, offset) => {
        // Calculate line number
        const textBefore = code.substring(0, offset);
        const lineNumber = textBefore.split('\n').length - 1;
        
        const uniqueId = `ASP_PLACEHOLDER_${blockCounter}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        aspBlocks.push({ 
            code: aspBlock, 
            indent: indent,
            id: uniqueId,
            lineNumber: lineNumber
        });
        blockCounter++;
        return indent + `<!--${uniqueId}-->`;
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
    
    // Step 3: Combine ASP blocks virtually for formatting, then restore them
    let restoredCode = prettifiedCode;

    // Virtually combine all ASP blocks
    const combinedAspCode = aspBlocks.map(block => block.code).join('\n');
    const combinedFormatted = formatSingleAspBlock(combinedAspCode, aspSettings, '', false);

    // Split the formatted combined code back into individual blocks
    const formattedBlockLines = combinedFormatted.split('\n');
    let currentLineIndex = 0;
    const formattedBlocks: string[] = [];

    for (let i = 0; i < aspBlocks.length; i++) {
        const originalBlock = aspBlocks[i];
        const originalLineCount = originalBlock.code.split('\n').length;
        
        // Extract the corresponding lines from formatted combined code
        const blockLines = formattedBlockLines.slice(currentLineIndex, currentLineIndex + originalLineCount);
        formattedBlocks.push(blockLines.join('\n'));
        currentLineIndex += originalLineCount;
    }

    // Restore each formatted block with its HTML indent
    for (let i = 0; i < aspBlocks.length; i++) {
        const block = aspBlocks[i];
        const formattedBlock = formattedBlocks[i];
        
        const placeholderRegex = new RegExp(`^([ \\t]*)<!--${block.id}-->`, 'gm');
        const match = placeholderRegex.exec(restoredCode);
        
        if (match) {
            const htmlIndent = match[1];
            
            // Add HTML indent to each line of the formatted block
            const indentedBlock = formattedBlock.split('\n').map(line => {
                if (line.trim()) {
                    return htmlIndent + line;
                }
                return line;
            }).join('\n');
            
            restoredCode = restoredCode.replace(
                new RegExp(`^[ \\t]*<!--${block.id}-->`, 'gm'),
                indentedBlock
            );
        } else {
            console.warn(`Warning: Placeholder ${block.id} not found`);
            restoredCode = restoredCode.replace(
                new RegExp(`<!--${block.id}-->`, 'g'),
                formattedBlock
            );
        }
    }

    return restoredCode;
}

// Fix closing brackets
function fixClosingBrackets(code: string): string {
    return code.replace(/(<\/[^>]+)\n\s*>/g, '$1>');
}