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

    // Step 1: Split off any content after </html> BEFORE masking.
    // Prettier will mangle or drop anything after </html>, so we preserve it separately.
    let htmlBody = code;
    let postHtmlContent = '';
    const postHtmlMatch = code.match(/^([\s\S]*<\/html>[ \t]*)([\s\S]+)$/i);
    if (postHtmlMatch && postHtmlMatch[2].trim()) {
        htmlBody = postHtmlMatch[1];
        postHtmlContent = postHtmlMatch[2];
    }

    // Step 2: Extract and mask ASP blocks with unique identifiers
    const aspBlocks: { code: string; indent: string; id: string; lineNumber: number; isInline: boolean }[] = [];
    let blockCounter = 0;

    const maskedCode = htmlBody.replace(/([ \t]*)(<%[\s\S]*?%>)/g, (match, indent, aspBlock, offset) => {
        // Check if this ASP block is inside an HTML tag (between < and >)
        const beforeMatch = htmlBody.substring(0, offset);
        const lastOpenTag = beforeMatch.lastIndexOf('<');
        const lastCloseTag = beforeMatch.lastIndexOf('>');

        const isInsideTag = lastOpenTag > lastCloseTag;

        const textBefore = htmlBody.substring(0, offset);
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

        if (isInsideTag) {
            return `__${uniqueId}__`;
        } else {
            return indent + `<!--${uniqueId}-->`;
        }
    });

    // Also mask ASP blocks in the post-html content (they will be restored later too)
    const maskedPostHtml = postHtmlContent.replace(/([ \t]*)(<%[\s\S]*?%>)/g, (match, indent, aspBlock, offset) => {
        const beforeMatch = postHtmlContent.substring(0, offset);
        const lastOpenTag = beforeMatch.lastIndexOf('<');
        const lastCloseTag = beforeMatch.lastIndexOf('>');
        const isInsideTag = lastOpenTag > lastCloseTag;

        const textBefore = postHtmlContent.substring(0, offset);
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

        if (isInsideTag) {
            return `__${uniqueId}__`;
        } else {
            return indent + `<!--${uniqueId}-->`;
        }
    });

    // Step 3: Format HTML/CSS/JS with Prettier
    // If Prettier fails for any reason, return the original code completely untouched.
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
        // Re-attach the post-</html> content (with its own masked placeholders)
        if (maskedPostHtml.trim()) {
            prettifiedCode = prettifiedCode.trimEnd() + '\n' + maskedPostHtml;
        }
    } catch (error) {
        console.error('Prettier formatting failed:', error);
        // Return original code completely untouched — do not risk losing anything
        return code;
    }

    // Step 4: Format ASP blocks
    const formattedBlocks: string[] = new Array(aspBlocks.length);
    let runningIndentLevel = 0;

    for (let i = 0; i < aspBlocks.length; i++) {
        const block = aspBlocks[i];

        if (block.isInline) {
            formattedBlocks[i] = block.code;
            continue;
        }

        const result = formatSingleAspBlock(block.code, aspSettings, '', runningIndentLevel);
        formattedBlocks[i] = result.code;
        runningIndentLevel = result.endIndentLevel;
    }

    // Step 5: Restore each formatted block
    let restoredCode = prettifiedCode;

    for (let i = 0; i < aspBlocks.length; i++) {
        const block = aspBlocks[i];
        const formattedBlock = formattedBlocks[i];

        if (block.isInline) {
            restoredCode = restoredCode.replace(`__${block.id}__`, formattedBlock);
        } else {
            const escapedId = block.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const placeholderPattern = `([ \\t]*)<!--${escapedId}-->`;
            const match = restoredCode.match(new RegExp(placeholderPattern));

            if (match) {
                let htmlIndent = match[1];

                // Check if the placeholder is truly on its own line (only whitespace before it)
                const placeholderPos = restoredCode.indexOf(`<!--${block.id}-->`);
                const lineStart = restoredCode.lastIndexOf('\n', placeholderPos - 1) + 1;
                const textBeforePlaceholder = restoredCode.substring(lineStart, placeholderPos);
                const placeholderIsOnOwnLine = /^[ \t]*$/.test(textBeforePlaceholder);

                // If Prettier collapsed indentation (e.g. inside <textarea>) and the placeholder
                // is on its own line, find the parent tag indent + one level
                if (!htmlIndent && placeholderIsOnOwnLine) {
                    const before = restoredCode.substring(0, placeholderPos);
                    const lines = before.split('\n');
                    for (let li = lines.length - 1; li >= 0; li--) {
                        if (/<[a-zA-Z]/.test(lines[li])) {
                            const indentMatch = lines[li].match(/^([ \t]*)/);
                            if (indentMatch) {
                                const extraIndent = prettierSettings.useTabs ? '\t' : ' '.repeat(prettierSettings.tabWidth);
                                htmlIndent = indentMatch[1] + extraIndent;
                            }
                            break;
                        }
                    }
                }

                // Add HTML indent to each line of the formatted block
                const indentedBlock = formattedBlock.split('\n').map(line => {
                    if (line.trim()) {
                        return htmlIndent + line;
                    }
                    return line;
                }).join('\n');

                // Only move closing tag to its own line when the placeholder was on its own line
                // (e.g. textarea content), not for inline cases like <td><%= x %></td>
                const closingTagPattern = new RegExp(`([ \\t]*)<!--${escapedId}-->(<\\/[a-zA-Z][^>]*>)`);
                const closingTagMatch = restoredCode.match(closingTagPattern);
                if (closingTagMatch && placeholderIsOnOwnLine) {
                    const parentIndent = htmlIndent.slice(0, Math.max(0, htmlIndent.length - prettierSettings.tabWidth));
                    restoredCode = restoredCode.replace(
                        closingTagPattern,
                        indentedBlock + '\n' + parentIndent + closingTagMatch[2]
                    );
                } else {
                    restoredCode = restoredCode.replace(
                        new RegExp(`[ \\t]*<!--${escapedId}-->`),
                        indentedBlock
                    );
                }
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