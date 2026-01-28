import * as vscode from 'vscode';
import * as prettier from 'prettier';
import { formatSingleAspBlock, getAspSettings } from './aspFormatter';

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
    
    // Step 3: Analyze blocks for cross-block context (If/Else detection)
    const blockContexts = analyzeBlockContexts(aspBlocks);
    
    // Step 4: Restore ASP blocks with context-aware formatting
    let restoredCode = prettifiedCode;
    
    for (let i = 0; i < aspBlocks.length; i++) {
        const block = aspBlocks[i];
        const context = blockContexts[i];
        
        const placeholderRegex = new RegExp(`^([ \\t]*)<!--${block.id}-->`, 'gm');
        const match = placeholderRegex.exec(restoredCode);
        
        if (match) {
            const htmlIndent = match[1];
            const formattedBlock = formatSingleAspBlockWithContext(block.code, aspSettings, htmlIndent, context);
            restoredCode = restoredCode.replace(
                new RegExp(`^[ \\t]*<!--${block.id}-->`, 'gm'),
                formattedBlock
            );
        } else {
            console.warn(`Warning: Placeholder ${block.id} not found`);
            const formattedBlock = formatSingleAspBlock(block.code, aspSettings, '');
            restoredCode = restoredCode.replace(
                new RegExp(`<!--${block.id}-->`, 'g'),
                formattedBlock
            );
        }
    }
    
    return restoredCode;
}

// Analyze blocks to detect cross-block control structures
function analyzeBlockContexts(blocks: Array<{ code: string; indent: string; id: string; lineNumber: number }>): Array<{ continuesFromPrevious: boolean; openControlStructures: number }> {
    const contexts: Array<{ continuesFromPrevious: boolean; openControlStructures: number }> = [];
    let openStructures = 0; // Track open If/For/While/etc.
    
    for (const block of blocks) {
        const trimmedCode = block.code.trim();
        const firstLine = trimmedCode.split('\n')[0].toLowerCase();
        
        // Check if this block starts with Else/ElseIf/End If/Loop/Wend/Next
        const continuesFromPrevious = /^<%\s*(else|elseif|end\s+if|end\s+sub|end\s+function|loop|wend|next|end\s+select)/i.test(firstLine);
        
        contexts.push({
            continuesFromPrevious: continuesFromPrevious,
            openControlStructures: openStructures
        });
        
        // Update open structures count based on this block's content
        const codeWithoutStrings = removeStringsFromCode(block.code);
        const ifCount = (codeWithoutStrings.match(/\bif\b.*\bthen\b/gi) || []).length;
        const endIfCount = (codeWithoutStrings.match(/\bend\s+if\b/gi) || []).length;
        const forCount = (codeWithoutStrings.match(/\bfor\b/gi) || []).length;
        const nextCount = (codeWithoutStrings.match(/\bnext\b/gi) || []).length;
        const whileCount = (codeWithoutStrings.match(/\bwhile\b/gi) || []).length;
        const wendCount = (codeWithoutStrings.match(/\bwend\b/gi) || []).length;
        const doCount = (codeWithoutStrings.match(/\bdo\b/gi) || []).length;
        const loopCount = (codeWithoutStrings.match(/\bloop\b/gi) || []).length;
        
        openStructures += ifCount - endIfCount;
        openStructures += forCount - nextCount;
        openStructures += whileCount - wendCount;
        openStructures += doCount - loopCount;
        openStructures = Math.max(0, openStructures);
    }
    
    return contexts;
}

// Remove strings from code for analysis
function removeStringsFromCode(code: string): string {
    return code.replace(/"[^"]*"/g, '""');
}

// Format ASP block with context awareness
function formatSingleAspBlockWithContext(block: string, settings: any, htmlIndent: string, context: { continuesFromPrevious: boolean; openControlStructures: number }): string {
    // If this block continues from previous (starts with Else/End If/etc), don't decrease indent at start
    if (context.continuesFromPrevious) {
        return formatSingleAspBlock(block, settings, htmlIndent, true);
    }
    return formatSingleAspBlock(block, settings, htmlIndent, false);
}

// Fix closing brackets
function fixClosingBrackets(code: string): string {
    return code.replace(/(<\/[^>]+)\n\s*>/g, '$1>');
}