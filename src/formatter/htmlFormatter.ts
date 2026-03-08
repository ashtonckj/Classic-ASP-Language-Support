import * as vscode from 'vscode';
import * as prettier from 'prettier';
import { formatSingleAspBlock, getAspSettings, FormatBlockResult } from './aspFormatter';

// ─── Prettier settings ─────────────────────────────────────────────────────

/**
 * Prettier formatting options surfaced under the
 * `aspLanguageSupport.prettier.*` configuration namespace.
 *
 * HTML, CSS, and JavaScript formatting is delegated entirely to Prettier
 * (https://prettier.io). These settings map 1-to-1 to Prettier's own options.
 */
export interface PrettierSettings {
    printWidth:                number;
    tabWidth:                  number;
    useTabs:                   boolean;
    semi:                      boolean;
    singleQuote:               boolean;
    bracketSameLine:           boolean;
    arrowParens:               string;
    trailingComma:             string;
    endOfLine:                 string;
    htmlWhitespaceSensitivity: string;
}

export function getPrettierSettings(): PrettierSettings {
    const c = vscode.workspace.getConfiguration('aspLanguageSupport.prettier');
    return {
        printWidth:                c.get<number>('printWidth',                80),
        tabWidth:                  c.get<number>('tabWidth',                  2),
        useTabs:                   c.get<boolean>('useTabs',                  false),
        semi:                      c.get<boolean>('semi',                     true),
        singleQuote:               c.get<boolean>('singleQuote',              false),
        bracketSameLine:           c.get<boolean>('bracketSameLine',          true),
        arrowParens:               c.get<string>('arrowParens',               'always'),
        trailingComma:             c.get<string>('trailingComma',             'es5'),
        endOfLine:                 c.get<string>('endOfLine',                 'lf'),
        htmlWhitespaceSensitivity: c.get<string>('htmlWhitespaceSensitivity', 'css'),
    };
}

// ─── ASP block types ───────────────────────────────────────────────────────

// Where in the HTML structure an ASP block sits:
//   normal  – standalone on its own line(s)   → HTML comment placeholder
//   inline  – inside a quoted attribute value → bare token placeholder
//   midtag  – between attributes, not quoted  → data- attribute placeholder
type AspBlockKind = 'normal' | 'inline' | 'midtag';

interface AspBlock {
    code:       string;
    id:         string;
    lineNumber: number;
    kind:       AspBlockKind;
}

// Module-level counter keeps IDs unique across calls in the same millisecond.
let _placeholderCounter = 0;

// ─── Safety check ─────────────────────────────────────────────────────────

/**
 * Returns true if the source has unmatched <% or %> tags.
 * An unclosed <% would cause the masking regex to consume everything after it.
 */
function hasUnclosedAspTags(code: string): boolean {
    let depth = 0;
    let i     = 0;

    while (i < code.length) {
        if (code[i] === '<' && code[i + 1] === '%') {
            depth++;
            i += 2;
        } else if (code[i] === '%' && code[i + 1] === '>') {
            if (depth === 0) return true; // stray %>
            depth--;
            i += 2;
        } else {
            i++;
        }
    }

    return depth !== 0;
}

// ─── ASP block classifier ─────────────────────────────────────────────────

/**
 * Walks backwards from `offset` in the original source to determine whether
 * the ASP block at that position is inside a quoted attribute value (inline),
 * between unquoted attributes (midtag), or free-standing (normal).
 */
function classifyOffset(code: string, offset: number): AspBlockKind {
    let inQuote: string | null = null;

    for (let i = offset - 1; i >= 0; i--) {
        const ch = code[i];

        if (inQuote) {
            if (ch === inQuote) inQuote = null;
            continue;
        }

        if (ch === '"' || ch === "'") {
            inQuote = ch; // hit closing quote while scanning backwards
            continue;
        }

        if (ch === '>') return 'normal';

        if (ch === '<') {
            const after = code.substring(i + 1, i + 3);
            if (after.startsWith('/'))        return 'normal';  // closing tag
            if (/^[a-zA-Z!?]/.test(after))   return 'midtag';  // opening/void tag
            return 'normal';
        }
    }

    return 'normal';
}

// ─── Main entry point ──────────────────────────────────────────────────────

export async function formatCompleteAspFile(code: string): Promise<string> {
    if (hasUnclosedAspTags(code)) {
        console.warn('ASP formatter: unclosed <% or stray %> — skipping format.');
        return code;
    }

    const aspSettings      = getAspSettings();
    const prettierSettings = getPrettierSettings();

    // ── Step 1: Mask all ASP blocks ──────────────────────────────────────────
    // Each ASP block is replaced with a placeholder that Prettier will treat as
    // valid HTML, preserving its position in the output.

    const aspBlocks: AspBlock[] = [];

    const maskedCode = code.replace(/([ \t]*)(<%[\s\S]*?%>)/g, (match, _indent, aspBlock, offset) => {
        const kind       = classifyOffset(code, offset);
        const lineNumber = code.slice(0, offset).split('\n').length - 1;
        const id         = `ASPPH${_placeholderCounter++}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

        aspBlocks.push({ code: aspBlock, id, lineNumber, kind });

        switch (kind) {
            case 'inline': return `ASPINLINE_${id}_END`;
            case 'midtag': return `data-asp-${id}="1"`;
            default:       return `<!--${id}-->`;
        }
    });

    // ── Step 2: Run Prettier on the masked HTML ──────────────────────────────

    let prettifiedCode: string;
    try {
        prettifiedCode = await prettier.format(maskedCode, {
            parser:                    'html',
            printWidth:                prettierSettings.printWidth,
            tabWidth:                  prettierSettings.tabWidth,
            useTabs:                   prettierSettings.useTabs,
            semi:                      prettierSettings.semi,
            singleQuote:               prettierSettings.singleQuote,
            bracketSameLine:           prettierSettings.bracketSameLine,
            arrowParens:               prettierSettings.arrowParens               as any,
            trailingComma:             prettierSettings.trailingComma             as any,
            endOfLine:                 prettierSettings.endOfLine                 as any,
            htmlWhitespaceSensitivity: prettierSettings.htmlWhitespaceSensitivity as any,
        });
    } catch (error) {
        console.error('ASP formatter: Prettier failed — returning original.', error);
        return code;
    }

    // ── Step 3: Verify all placeholders survived Prettier ───────────────────

    for (const block of aspBlocks) {
        const needle =
            block.kind === 'inline' ? `ASPINLINE_${block.id}_END` :
            block.kind === 'midtag' ? `data-asp-${block.id}`       :
            block.id;

        if (!prettifiedCode.includes(needle)) {
            console.error(
                `ASP formatter: placeholder for block at line ${block.lineNumber} was ` +
                `lost by Prettier — returning original.`
            );
            return code;
        }
    }

    // ── Step 4: Format each ASP block's VBScript content ────────────────────
    // Process blocks sequentially so each normal block can thread its ending
    // indent level into the next, enabling cross-block continuity.

    const formattedBlocks: string[] = [];
    let   currentIndentLevel        = 0;

    for (const block of aspBlocks) {
        if (block.kind !== 'normal') {
            // Inline / midtag blocks: format but don't change the tracked level.
            const result = formatSingleAspBlock(block.code, aspSettings, '', currentIndentLevel);
            formattedBlocks.push(result.formatted);
            continue;
        }

        // For normal blocks, capture the HTML indent Prettier placed before
        // the placeholder comment so the VBScript formatter can use it when
        // htmlIndentMode is 'continuation'.
        const escapedId  = block.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const indentMatch = prettifiedCode.match(new RegExp(`([ \\t]*)<!--${escapedId}-->`));
        const htmlIndent  = indentMatch ? indentMatch[1] : '';

        const result = formatSingleAspBlock(block.code, aspSettings, htmlIndent, currentIndentLevel);
        formattedBlocks.push(result.formatted);
        currentIndentLevel = result.endLevel;
    }

    // ── Step 5: Restore formatted ASP blocks into Prettier's output ─────────

    let restoredCode = prettifiedCode;

    for (let i = 0; i < aspBlocks.length; i++) {
        const block     = aspBlocks[i];
        const formatted = formattedBlocks[i];
        const escapedId = block.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        switch (block.kind) {

            case 'inline':
                // Replace the bare token directly — no indent adjustment needed.
                restoredCode = restoredCode.replace(
                    `ASPINLINE_${block.id}_END`,
                    formatted
                );
                break;

            case 'midtag':
                // Prettier may have normalised quotes/spacing around the attribute.
                restoredCode = restoredCode.replace(
                    new RegExp(`\\s*data-asp-${escapedId}\\s*=\\s*["']1["']`),
                    ` ${formatted}`
                );
                break;

            default: {
                // Pick up whatever indentation Prettier assigned to the comment
                // line, then prepend it to every non-empty line of the formatted
                // ASP block (the VBScript formatter itself handles internal
                // indentation relative to that base).
                const match = restoredCode.match(new RegExp(`([ \\t]*)<!--${escapedId}-->`));

                if (match) {
                    const htmlIndent    = match[1];
                    const indentedBlock = formatted
                        .split('\n')
                        .map(line => (line.trim() ? htmlIndent + line : line))
                        .join('\n');

                    restoredCode = restoredCode.replace(
                        new RegExp(`[ \\t]*<!--${escapedId}-->`),
                        indentedBlock
                    );
                } else {
                    // Safety fallback — the placeholder-lost check above should
                    // have already caught real deletions, but guard anyway.
                    restoredCode = restoredCode.replace(`<!--${block.id}-->`, formatted);
                }
                break;
            }
        }
    }

    return restoredCode;
}