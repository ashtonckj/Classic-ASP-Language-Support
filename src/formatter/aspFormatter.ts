import * as vscode from 'vscode';
import { isRemAt, removeStrings } from '../utils/documentHelper';

// ─── Settings ──────────────────────────────────────────────────────────────

export interface AspFormatterSettings {
    keywordCase:       string;   // 'lowercase' | 'UPPERCASE' | 'PascalCase'
    useTabs:           boolean;
    indentSize:        number;
    aspTagsOnSameLine: boolean;
    htmlIndentMode:    string;   // 'flat' | 'continuation'
}

/**
 * Whether `<%` and `%>` go to column 0 rather than to the indent of the HTML
 * around them. The VBScript INSIDE the block is indented the same either way;
 * only the delimiters move.
 *
 * Every site that cares asks this rather than comparing the setting string. The
 * two values used to be wired up as each other — `flat` was documented as
 * "always starts at column 0" and put the delimiters at the HTML depth, while
 * `continuation` was documented as continuing from the HTML indent and put them
 * at column 0 — and six separate `=== 'continuation'` checks spread across two
 * files is how that stayed unnoticed. One named question is harder to get
 * backwards than six inverted comparisons.
 */
export function delimitersAtColumnZero(settings: AspFormatterSettings): boolean {
    return settings.htmlIndentMode === 'flat';
}

export function getAspSettings(): AspFormatterSettings {
    const config         = vscode.workspace.getConfiguration('aspLanguageSupport');
    const prettierConfig = vscode.workspace.getConfiguration('aspLanguageSupport.prettier');
    return {
        keywordCase:       config.get<string>('keywordCase',             'PascalCase'),
        useTabs:           prettierConfig.get<boolean>('useTabs',        false),
        indentSize:        prettierConfig.get<number>('tabWidth',        2),
        aspTagsOnSameLine: config.get<boolean>('aspTagsOnSameLine',      false),
        htmlIndentMode:    config.get<string>('htmlIndentMode',          'continuation'),
    };
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface FormatBlockResult {
    formatted: string;
    // VBScript indent level at the end of this block, threaded into the next.
    endLevel: number;
}

/**
 * Formats a single <% ... %> block.
 *
 * @param block         Raw ASP block including the <% and %> delimiters.
 * @param settings      Formatter settings.
 * @param htmlIndent    Whitespace string that Prettier placed before the
 *                      placeholder comment — used only when the delimiters go
 *                      to column 0, so the VBScript inside carries the depth.
 * @param startLevel    VBScript indent level inherited from the previous block.
 */
export function formatSingleAspBlock(
    block:      string,
    settings:   AspFormatterSettings,
    htmlIndent: string = '',
    startLevel: number = 0,
): FormatBlockResult {

    const trimmedBlock = block.trim();

    // ── <%@ ... %> — processing directive ───────────────────────────────────
    // The @ must stay glued to the <% on a single line. IIS only recognises the
    // directive in the exact form `<%@ … %>`; once a newline separates them the
    // page is compiled as ordinary VBScript and `@ Language = "VBScript"` is a
    // syntax error. Directive names are not VBScript keywords either, so the
    // content is emitted verbatim — no keyword casing, no operator spacing.
    if (trimmedBlock.startsWith('<%@')) {
        return {
            formatted: '<%@ ' + trimmedBlock.slice(3, -2).trim() + ' %>',
            endLevel:  startLevel,
        };
    }

    // ── <%= expression %> — output expression, no indent tracking ──────────
    if (trimmedBlock.startsWith('<%=') || trimmedBlock.startsWith('<% =')) {
        const content = trimmedBlock.startsWith('<%=')
            ? trimmedBlock.slice(3, -2).trim()
            : trimmedBlock.slice(4, -2).trim();
        return {
            formatted: '<%= ' + applyKeywordCase(content, settings.keywordCase) + ' %>',
            endLevel:  startLevel,
        };
    }

    // ── Single-line block: <% statement %> ─────────────────────────────────
    if (!block.includes('\n')) {
        const content          = block.slice(2, -2).trim();
        const formattedContent = applyKeywordCase(content, settings.keywordCase);

        // Determine the VBScript indent level for this lone statement.
        const selectCaseStack: number[] = [];
        const { printLevel: levelBefore, endLevel: levelAfter } =
            applyIndentForLine(content, startLevel, selectCaseStack);

        if (settings.aspTagsOnSameLine) {
            return {
                formatted: '<% ' + formattedContent + ' %>',
                endLevel:  levelAfter,
            };
        }

        // An empty block has no content line to write. Emitting one anyway left
        // `<%` and `%>` separated by a blank line — or by a line of nothing but
        // indentation, which is worse because it is invisible.
        if (formattedContent.length === 0) {
            return { formatted: '<%\n%>', endLevel: levelAfter };
        }

        // The base level has to match what a multi-line block would use, or the
        // two disagree: with the delimiters at column 0 the multi-line path starts
        // from the HTML depth while this path started from zero, so a one-line
        // block came out at column 0 and then moved once the first format had
        // turned it into a multi-line one — two passes to settle.
        const baseLevel = delimitersAtColumnZero(settings)
            ? inferLevelFromIndent(htmlIndent, settings.useTabs, settings.indentSize)
            : 0;
        const aspIndent = getIndentString(baseLevel + levelBefore, settings.useTabs, settings.indentSize);
        return {
            formatted: '<%\n' + aspIndent + formattedContent + '\n%>',
            endLevel:  levelAfter,
        };
    }

    // ── Multi-line block ────────────────────────────────────────────────────
    return formatMultiLineAspBlock(block, settings, htmlIndent, startLevel);
}

// ─── Multi-line formatter ──────────────────────────────────────────────────

function formatMultiLineAspBlock(
    block:      string,
    settings:   AspFormatterSettings,
    htmlIndent: string,
    startLevel: number,
): FormatBlockResult {

    // When the delimiters sit at column 0 the VBScript inside has to carry the
    // HTML depth itself, inferred from htmlIndent. When they sit at the HTML
    // indent the surrounding indent already supplies it, so the base is 0.
    const baseLevel = delimitersAtColumnZero(settings)
        ? inferLevelFromIndent(htmlIndent, settings.useTabs, settings.indentSize)
        : 0;

    const lines            = block.split('\n');
    const formattedLines:  string[] = [];
    let   aspIndentLevel   = startLevel;
    const selectCaseStack: number[] = [];

    // Line-continuation state
    let prevHadContinuation   = false;
    let continuationAlignCol  = 0;
    let inMultilineString     = false;
    let isInSQLBlock          = false;
    let sqlBaseIndent         = 0;

    for (let i = 0; i < lines.length; i++) {
        const raw     = lines[i];
        const trimmed = raw.trim();

        // ── VBScript comment line — MUST be checked before <% / %> ────────
        // A line like  ' <%response.write x%>  trims to start with '
        // but the old code hit the startsWith('<%') branch first and
        // treated the embedded tag as real code.  Comments always win.
        if (trimmed.startsWith("'")) {
            // Align comment with the indent of the next real code line.
            let commentLevel = aspIndentLevel;
            for (let j = i + 1; j < lines.length; j++) {
                const next = lines[j].trim();
                if (next && !next.startsWith("'") && next !== '%>') {
                    commentLevel = applyIndentBefore(next, aspIndentLevel, [...selectCaseStack]).level;
                    break;
                }
            }
            const aspIndent = getIndentString(baseLevel + commentLevel, settings.useTabs, settings.indentSize);
            formattedLines.push(aspIndent + trimmed);
            prevHadContinuation = false;
            isInSQLBlock        = false;
            continue;
        }

        // ── <% opening tag line ──────────────────────────────────────────
        if (trimmed.startsWith('<%')) {
            if (trimmed === '<%') {
                formattedLines.push('<%');
                prevHadContinuation = false;
                isInSQLBlock        = false;
                continue;
            }

            const content = trimmed.slice(2).trim();
            if (content) {
                const indent       = applyIndentForLine(content, aspIndentLevel, selectCaseStack);
                aspIndentLevel     = indent.printLevel;
                const aspIndent    = getIndentString(baseLevel + aspIndentLevel, settings.useTabs, settings.indentSize);
                const formatted    = applyKeywordCase(content, settings.keywordCase);

                if (settings.aspTagsOnSameLine) {
                    formattedLines.push('<% ' + formatted);
                } else {
                    formattedLines.push('<%');
                    formattedLines.push(aspIndent + formatted);
                }

                updateContinuationState(formatted, aspIndent, {
                    prevHadContinuation, continuationAlignCol, inMultilineString,
                    isInSQLBlock, sqlBaseIndent,
                }, v => {
                    ({ prevHadContinuation, continuationAlignCol, inMultilineString,
                       isInSQLBlock, sqlBaseIndent } = v);
                });

                aspIndentLevel = indent.endLevel;
            }
            continue;
        }

        // ── %> closing tag line ──────────────────────────────────────────
        if (trimmed === '%>' || trimmed.endsWith('%>')) {
            if (trimmed === '%>') {
                formattedLines.push('%>');
                prevHadContinuation = false;
                inMultilineString   = false;
                isInSQLBlock        = false;
                continue;
            }

            const content = trimmed.slice(0, -2).trim();
            if (content) {
                const formatted = applyKeywordCase(content, settings.keywordCase);
                let   aspIndent: string;

                if (prevHadContinuation) {
                    // This line finishes a `_` continuation AND closes the
                    // block, so it is a continuation line first and a closing
                    // line second. Reading it as a fresh statement put it at the
                    // statement indent — column 0 — and only the NEXT format, by
                    // which time `%>` had moved to a line of its own, gave it the
                    // alignment column. Its indent level must not move either:
                    // `b Then` is half of `If a And b Then`, not a statement.
                    aspIndent = continuationIndent(
                        continuationAlignCol, baseLevel, aspIndentLevel, settings);
                } else {
                    const indent   = applyIndentForLine(content, aspIndentLevel, selectCaseStack);
                    aspIndentLevel = indent.printLevel;
                    aspIndent      = getIndentString(baseLevel + aspIndentLevel, settings.useTabs, settings.indentSize);
                    aspIndentLevel = indent.endLevel;
                }

                if (settings.aspTagsOnSameLine) {
                    formattedLines.push(aspIndent + formatted + ' %>');
                } else {
                    formattedLines.push(aspIndent + formatted);
                    formattedLines.push('%>');
                }
            } else {
                formattedLines.push('%>');
            }
            prevHadContinuation = false;
            inMultilineString   = false;
            isInSQLBlock        = false;
            continue;
        }

        // ── Empty line ───────────────────────────────────────────────────
        if (!trimmed) {
            // Collapse runs of multiple blank lines to a single blank line.
            const lastLine = formattedLines[formattedLines.length - 1];
            if (lastLine !== '') {
                formattedLines.push('');
            }
            if (!inMultilineString) {
                prevHadContinuation = false;
                isInSQLBlock        = false;
            }
            continue;
        }

        // ── Line-continuation continuation line ──────────────────────────
        if (prevHadContinuation) {
            const startsWithString = trimmed.startsWith('"');

            if (!startsWithString) {
                // If we have a valid align column from the first line of the
                // continuation (e.g. subQuery = "(SELECT " & _  → col 11), use it
                // for variable lines too so they align with string lines.
                formattedLines.push(
                    continuationIndent(continuationAlignCol, baseLevel, aspIndentLevel, settings) + trimmed);

                if (!trimmed.trimEnd().endsWith('_')) {
                    prevHadContinuation = false;
                    inMultilineString   = false;
                    isInSQLBlock        = false;
                }
                continue;
            }

            // Line starts with a string literal — align to quote column as before.
            if (isInSQLBlock) {
                const originalIndent = raw.length - raw.trimStart().length;
                const relativeIndent = originalIndent - sqlBaseIndent;
                const extraLevel     = relativeIndent > 0 ? 1 : 0;
                const aspIndent      = getIndentString(baseLevel + aspIndentLevel + 1 + extraLevel, settings.useTabs, settings.indentSize);
                formattedLines.push(aspIndent + trimmed);
            } else {
                formattedLines.push(
                    continuationIndent(continuationAlignCol, baseLevel, aspIndentLevel, settings) + trimmed);
            }

            if (!trimmed.trimEnd().endsWith('_')) {
                prevHadContinuation = false;
                inMultilineString   = false;
                isInSQLBlock        = false;
            }
            continue;
        }

        // ── Normal VBScript line ─────────────────────────────────────────
        const indent            = applyIndentForLine(trimmed, aspIndentLevel, selectCaseStack);
        aspIndentLevel          = indent.printLevel;
        const aspIndent         = getIndentString(baseLevel + aspIndentLevel, settings.useTabs, settings.indentSize);
        const formattedContent  = applyKeywordCase(trimmed, settings.keywordCase);

        updateContinuationState(formattedContent, aspIndent, {
            prevHadContinuation, continuationAlignCol, inMultilineString,
            isInSQLBlock, sqlBaseIndent,
        }, v => {
            ({ prevHadContinuation, continuationAlignCol, inMultilineString,
               isInSQLBlock, sqlBaseIndent } = v);
        });

        formattedLines.push(aspIndent + formattedContent);
        aspIndentLevel = indent.endLevel;
    }

    return {
        formatted: formattedLines.join('\n'),
        endLevel:  aspIndentLevel,
    };
}

// ─── Indent logic ──────────────────────────────────────────────────────────

/**
 * Decrements the indent level BEFORE printing a line (for closing keywords).
 * Returns the level at which this line should be printed.
 */
export function applyIndentBefore(
    line:             string,
    level:            number,
    selectCaseStack:  number[],
): { level: number } {
    const lower = removeStrings(line).toLowerCase().trim();

    // End Select — pop the Select Case stack.
    if (/^\s*end\s+select\b/.test(lower)) {
        return { level: selectCaseStack.length > 0 ? selectCaseStack.pop()! : Math.max(0, level - 2) };
    }

    // Case / Case Else — jump back to Case-label level (baseLevel + 1).
    if (/^\s*case(\s|$)/.test(lower)) {
        return {
            level: selectCaseStack.length > 0
                ? selectCaseStack[selectCaseStack.length - 1] + 1
                : Math.max(0, level - 1),
        };
    }

    // Standard dedent-before keywords.
    // "Next" must NOT match "On Error Resume Next" — that is not a For/Next closer.
    if (
        /^\s*end\s+(if|sub|function|with|class|property)\b/.test(lower)             ||
        (/^\s*(loop|next|wend)(\s|$)/.test(lower) && !/resume\s+next/.test(lower))  ||
        /^\s*else(\s|$)/.test(lower)                                                 ||
        /^\s*elseif\b/.test(lower)
    ) {
        return { level: Math.max(0, level - 1) };
    }

    return { level };
}

/**
 * Increments the indent level AFTER printing a line (for opening keywords).
 */
export function applyIndentAfter(
    line:            string,
    level:           number,
    selectCaseStack: number[],
): number {
    const lower = removeStrings(line).toLowerCase().trim();

    // Single-line If ... Then <statement> — no indent change.
    if (/\bif\b.*\bthen\b\s+\S/.test(lower)) return level;

    // Select Case — push current level, jump to level+1 for Case labels.
    if (/\bselect\s+case\b/.test(lower)) {
        selectCaseStack.push(level);
        return level + 1;
    }

    // Case / Case Else — body is one deeper than the Case label.
    if (/^\s*case(\s|$)/.test(lower)) return level + 1;

    // Standard indent-after keywords.
    // Each rule has a guard to prevent false positives on closing keywords
    // that happen to contain an opener word (e.g. "End With" contains "With").
    if (
        /\bif\b.*\bthen\b/.test(lower)                                              ||
        /\bfor\b\s+\w+\s*=/.test(lower)                                             ||
        /\bfor\s+each\b/.test(lower)                                                ||
        // "While" must NOT match "Loop While ..." (that is a Do/Loop post-condition closer).
        (/\bwhile\b/.test(lower)   && !/^\s*loop\b/.test(lower))                    ||
        /\bdo\b(\s+while|\s+until)?(\s|$)/.test(lower)                              ||
        /\bsub\b\s+\w+/.test(lower)                                                ||
        /\bfunction\b\s+\w+/.test(lower)                                           ||
        // "With" must NOT match "End With".
        (/\bwith\b/.test(lower)    && !/^\s*end\s+with\b/.test(lower))             ||
        // "Class" must NOT match "End Class".
        (/\bclass\b\s+\w+/.test(lower) && !/^\s*end\s+class\b/.test(lower))      ||
        /\bproperty\s+(get|let|set)\b/.test(lower)                                  ||
        /^\s*else(\s|$)/.test(lower)                                                 ||
        /^\s*elseif\b.*\bthen\b/.test(lower)
    ) {
        return level + 1;
    }

    return level;
}

// ─── Colon-joined statements ────────────────────────────────────────────────

/**
 * Splits a VBScript logical line into its `:`-separated statements. A colon is a
 * statement separator in VBScript, so `For i = 1 To 3 : Next` is a COMPLETE loop
 * on one line. Respects string literals (`""` escapes a quote, a `:` inside "…"
 * is data) and ignores a trailing comment. Returns at least one (possibly empty)
 * segment.
 */
function splitStatements(line: string): string[] {
    const { code } = splitOffComment(line);
    const parts: string[] = [];
    let cur   = '';
    let inStr = false;

    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '"') {
            if (code[i + 1] === '"') { cur += '""'; i++; continue; } // "" escaped quote
            inStr = !inStr;
            cur += ch;
            continue;
        }
        if (ch === ':' && !inStr) { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    parts.push(cur);

    const nonEmpty = parts.filter(p => p.trim().length > 0);
    return nonEmpty.length > 0 ? nonEmpty : [''];
}

/**
 * Applies the indent deltas of EVERY `:`-separated statement on a line, so a
 * one-liner such as `For i = 1 To 3 : Next` (open + close) nets to zero and does
 * not over-indent the following line. For a single-statement line this is exactly
 * applyIndentBefore → applyIndentAfter (no behaviour change).
 *
 * Returns the level to PRINT this line at (after the first statement's dedent)
 * and the level to carry to the NEXT line (after every statement's delta).
 */
export function applyIndentForLine(
    line:            string,
    level:           number,
    selectCaseStack: number[],
): { printLevel: number; endLevel: number } {
    const stmts = splitStatements(line);
    let lvl        = level;
    let printLevel = level;

    for (let k = 0; k < stmts.length; k++) {
        const before = applyIndentBefore(stmts[k], lvl, selectCaseStack).level;
        if (k === 0) { printLevel = before; }
        lvl = applyIndentAfter(stmts[k], before, selectCaseStack);
    }

    return { printLevel, endLevel: lvl };
}

// ─── Line-continuation state ───────────────────────────────────────────────

interface ContinuationState {
    prevHadContinuation:  boolean;
    continuationAlignCol: number;
    inMultilineString:    boolean;
    isInSQLBlock:         boolean;
    sqlBaseIndent:        number;
}

function updateContinuationState(
    formattedLine: string,
    aspIndent:     string,
    state:         ContinuationState,
    setState:      (v: ContinuationState) => void,
): void {
    if (formattedLine.trimEnd().endsWith('_')) {
        const col   = calcContinuationColumn(formattedLine, aspIndent);
        const isSql = isSQLStatement(formattedLine);
        setState({
            prevHadContinuation:  true,
            continuationAlignCol: col,
            inMultilineString:    true,
            isInSQLBlock:         isSql,
            sqlBaseIndent:        isSql ? aspIndent.length : state.sqlBaseIndent,
        });
    } else {
        setState({
            ...state,
            prevHadContinuation: false,
            inMultilineString:   false,
            isInSQLBlock:        false,
        });
    }
}

/**
 * The indent a line continued from the previous one with `_` takes: the column
 * of the string it should line up under, or one level in when the first line
 * had no string to align to.
 *
 * Shared by the two places that print such a line — an ordinary continuation
 * line, and one that also happens to close the block — because those two
 * disagreeing is exactly the bug this exists to prevent.
 */
function continuationIndent(
    continuationAlignCol: number,
    baseLevel:            number,
    aspIndentLevel:       number,
    settings:             AspFormatterSettings,
): string {
    return continuationAlignCol !== -1
        ? ' '.repeat(continuationAlignCol)
        : getIndentString(baseLevel + aspIndentLevel + 1, settings.useTabs, settings.indentSize);
}

function calcContinuationColumn(line: string, indent: string): number {
    const trimmed   = line.trim();
    const baseLen   = indent.length;
    const equalsPos = trimmed.indexOf('=');

    if (equalsPos !== -1) {
        const afterEq = trimmed.slice(equalsPos + 1).trim();
        if (afterEq.startsWith('"')) {
            return baseLen + equalsPos + trimmed.slice(equalsPos).indexOf('"');
        }
    }

    const quotePos = trimmed.indexOf('"');
    if (quotePos !== -1) return baseLen + quotePos;

    return -1; // No string — use +1 indent level.
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getIndentString(level: number, useTabs: boolean, indentSize: number): string {
    const n = Math.max(0, level);
    return useTabs ? '\t'.repeat(n) : ' '.repeat(n * indentSize);
}

/**
 * Infers a numeric indent level from a whitespace prefix string.
 * Handles both tab-based and space-based indentation gracefully.
 */
function inferLevelFromIndent(indent: string, useTabs: boolean, indentSize: number): number {
    if (!indent) return 0;
    if (useTabs) return indent.split('\t').length - 1;
    return Math.floor(indent.length / Math.max(1, indentSize));
}

function isSQLStatement(line: string): boolean {
    return /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|ORDER\s+BY|GROUP\s+BY|UNION|CREATE|DROP|ALTER|INNER|LEFT|RIGHT|OUTER|HAVING|DISTINCT|VALUES|INTO)\b/i
        .test(removeStrings(line));
}

/**
 * Splits a VBScript code string into alternating non-string / string segments
 * so that keyword and operator transforms are never applied inside literals.
 */
function splitByStrings(code: string): Array<{ text: string; isString: boolean }> {
    const parts: Array<{ text: string; isString: boolean }> = [];
    let   current  = '';
    let   inString = false;

    for (let i = 0; i < code.length; i++) {
        if (code[i] === '"') {
            if (i + 1 < code.length && code[i + 1] === '"') {
                current += '""';
                i++;
                continue;
            }
            if (inString) {
                current += '"';
                parts.push({ text: current, isString: true });
                current  = '';
                inString = false;
            } else {
                if (current) parts.push({ text: current, isString: false });
                current  = '"';
                inString = true;
            }
        } else {
            current += code[i];
        }
    }

    if (current) parts.push({ text: current, isString: inString });
    return parts;
}

/**
 * Splits a line into its code portion and a trailing VBScript comment (`' …`),
 * respecting string literals so an apostrophe inside "…" is not mistaken for the
 * start of a comment. `comment` includes its leading `'` (or is '' when none).
 */
function splitOffComment(line: string): { code: string; comment: string } {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (line[i + 1] === '"') { i++; continue; } // "" = escaped quote
            inString = !inString;
        } else if (!inString && (ch === "'" || isRemAt(line, i))) {
            return { code: line.slice(0, i), comment: line.slice(i) };
        }
    }
    return { code: line, comment: '' };
}

// ─── Keyword casing ────────────────────────────────────────────────────────

// Multi-word and special-cased keywords that need exact casing.
const PROPER_CASING_MAP: Record<string, string> = {
    'elseif': 'ElseIf', 'redim': 'ReDim', 'byval': 'ByVal',
    'byref': 'ByRef', 'isnull': 'IsNull', 'isempty': 'IsEmpty',
    'isnumeric': 'IsNumeric', 'isarray': 'IsArray', 'isobject': 'IsObject',
    'isdate': 'IsDate', 'readonly': 'ReadOnly', 'writeonly': 'WriteOnly',
    'typename': 'TypeName', 'vartype': 'VarType', 'getobject': 'GetObject',
    'createobject': 'CreateObject', 'getref': 'GetRef', 'endif': 'EndIf',
    'endsub': 'EndSub', 'endfunction': 'EndFunction', 'endwith': 'EndWith',
    'endselect': 'EndSelect', 'endclass': 'EndClass', 'endproperty': 'EndProperty',
    'exitfor': 'ExitFor', 'exitdo': 'ExitDo', 'exitsub': 'ExitSub',
    'exitfunction': 'ExitFunction', 'exitproperty': 'ExitProperty', 'onerror': 'OnError', 'goto': 'GoTo',
    'on error goto 0': 'On Error GoTo 0',
};

/**
 * Names that belong to an object rather than to the language — Response.Buffer,
 * rs.MoveNext, fso.GetFile. They are cased ONLY after a dot.
 *
 * They used to be cased wherever they appeared, which meant the formatter
 * quietly renamed people's variables: `Dim connectionString` came back as
 * `Dim ConnectionString`, `For Each item` as `For Each Item`. VBScript is
 * case-insensitive so nothing broke, but rewriting a name the author chose is
 * not the formatter's business. After a dot the name really is the API's, and
 * casing it to match the documentation is worth doing.
 */
const MEMBER_CASING_MAP: Record<string, string> = {
    'absolutepage': 'AbsolutePage', 'absoluteposition': 'AbsolutePosition', 'add': 'Add',
    'addheader': 'AddHeader', 'addnew': 'AddNew', 'appendtolog': 'AppendToLog',
    'atendofline': 'AtEndOfLine', 'atendofstream': 'AtEndOfStream', 'begintrans': 'BeginTrans',
    'binaryread': 'BinaryRead', 'binarywrite': 'BinaryWrite', 'buildpath': 'BuildPath',
    'cacheecontrol': 'CacheControl', 'clearheaders': 'ClearHeaders', 'clientcertificate': 'ClientCertificate',
    'close': 'Close', 'closetext': 'CloseText', 'codepage': 'CodePage',
    'commandtext': 'CommandText', 'commandtype': 'CommandType', 'committrans': 'CommitTrans',
    'connectionstring': 'ConnectionString', 'contentlength': 'ContentLength', 'contenttype': 'ContentType',
    'cookies': 'Cookies', 'copyfile': 'CopyFile', 'copyfolder': 'CopyFolder',
    'count': 'Count', 'createfolder': 'CreateFolder', 'createtextfile': 'CreateTextFile',
    'cursorlocation': 'CursorLocation', 'cursortype': 'CursorType', 'datecreated': 'DateCreated',
    'datelastaccessed': 'DateLastAccessed', 'datelastmodified': 'DateLastModified', 'deletefile': 'DeleteFile',
    'deletefolder': 'DeleteFolder', 'dictionary': 'Dictionary', 'driveexists': 'DriveExists',
    'exists': 'Exists', 'expiresabsolute': 'ExpiresAbsolute', 'fileexists': 'FileExists',
    'filesystemobject': 'FileSystemObject', 'folderexists': 'FolderExists', 'form': 'Form',
    'getabsolutepathname': 'GetAbsolutePathName', 'getbasename': 'GetBaseName', 'getdrive': 'GetDrive',
    'getdrivename': 'GetDriveName', 'getextensionname': 'GetExtensionName', 'getfile': 'GetFile',
    'getfilename': 'GetFileName', 'getfolder': 'GetFolder', 'getlasterror': 'GetLastError',
    'getparentfoldername': 'GetParentFolderName', 'getspecialfolder': 'GetSpecialFolder', 'gettempname': 'GetTempName',
    'htmlencode': 'HTMLEncode', 'isclientconnected': 'IsClientConnected', 'item': 'Item',
    'items': 'Items', 'key': 'Key', 'keys': 'Keys',
    'lcid': 'LCID', 'locktype': 'LockType', 'mappath': 'MapPath',
    'movefile': 'MoveFile', 'movefirst': 'MoveFirst', 'movefolder': 'MoveFolder',
    'movelast': 'MoveLast', 'movenext': 'MoveNext', 'moveprevious': 'MovePrevious',
    'open': 'Open', 'opentextfile': 'OpenTextFile', 'pagecount': 'PageCount',
    'pagesize': 'PageSize', 'parentfolder': 'ParentFolder', 'pics': 'PICS',
    'querystring': 'QueryString', 'readall': 'ReadAll', 'readline': 'ReadLine',
    'recordcount': 'RecordCount', 'recordset': 'Recordset', 'redirect': 'Redirect',
    'remove': 'Remove', 'removeall': 'RemoveAll', 'rollbacktrans': 'RollbackTrans',
    'rootfolder': 'RootFolder', 'scripting': 'Scripting', 'scripttimeout': 'ScriptTimeout',
    'servervariables': 'ServerVariables', 'sessionid': 'SessionID', 'shortname': 'ShortName',
    'shortpath': 'ShortPath', 'skipline': 'SkipLine', 'totalbytes': 'TotalBytes',
    'urlencode': 'URLEncode', 'write': 'Write', 'writeblanklines': 'WriteBlankLines',
    'writeline': 'WriteLine',
};

const VBSCRIPT_FUNCTIONS_MAP: Record<string, string> = {
    'cbool': 'CBool', 'cbyte': 'CByte', 'ccur': 'CCur', 'cdate': 'CDate',
    'cdbl': 'CDbl', 'cint': 'CInt', 'clng': 'CLng', 'csng': 'CSng',
    'cstr': 'CStr', 'cvar': 'CVar',
    'isarray': 'IsArray', 'isdate': 'IsDate', 'isempty': 'IsEmpty',
    'isnull': 'IsNull', 'isnumeric': 'IsNumeric', 'isobject': 'IsObject',
    'lcase': 'LCase', 'ucase': 'UCase', 'ltrim': 'LTrim', 'rtrim': 'RTrim',
    'instr': 'InStr', 'instrrev': 'InStrRev', 'strreverse': 'StrReverse',
    'strcomp': 'StrComp',
    'dateserial': 'DateSerial', 'timeserial': 'TimeSerial',
    'datevalue': 'DateValue', 'timevalue': 'TimeValue',
    'dateadd': 'DateAdd', 'datediff': 'DateDiff', 'datepart': 'DatePart',
    'formatdatetime': 'FormatDateTime', 'formatnumber': 'FormatNumber',
    'formatcurrency': 'FormatCurrency', 'formatpercent': 'FormatPercent',
    'monthname': 'MonthName', 'weekdayname': 'WeekdayName',
    'lbound': 'LBound', 'ubound': 'UBound',
    'createobject': 'CreateObject', 'getobject': 'GetObject',
    'msgbox': 'MsgBox', 'inputbox': 'InputBox',
    'typename': 'TypeName', 'vartype': 'VarType', 'getref': 'GetRef',
    'eval': 'Eval', 'loadpicture': 'LoadPicture', 'scriptengine': 'ScriptEngine',
    'scriptenginebuildversion': 'ScriptEngineBuildVersion',
    'scriptenginemajorversion': 'ScriptEngineMajorVersion',
    'scriptengineminorversion': 'ScriptEngineMinorVersion',
    'rgb': 'RGB', 'escape': 'Escape', 'unescape': 'Unescape',
    'getlocale': 'GetLocale', 'setlocale': 'SetLocale',
};

// General VBScript keywords ordered longest-first so multi-word keywords
// like "end function" are matched before single-word ones like "end".
const KEYWORDS_SORTED: string[] = [
    'if', 'then', 'else', 'elseif', 'end if', 'select case', 'case',
    'case else', 'end select', 'for', 'to', 'step', 'next', 'for each',
    'in', 'while', 'wend', 'do', 'loop', 'until', 'exit do',
    'exit for', 'sub', 'end sub', 'function', 'end function', 'call', 'exit sub',
    'exit function', 'dim', 'redim', 'preserve', 'const', 'private', 'public',
    'static', 'class', 'end class', 'new', 'set', 'property get', 'property let',
    'property set', 'end property', 'on error resume next', 'on error goto 0', 'err', 'error', 'and',
    'or', 'not', 'xor', 'eqv', 'imp', 'is', 'nothing',
    'null', 'empty', 'true', 'false', 'option explicit', 'randomize', 'with',
    'end with', 'exit', 'mod', 'byval', 'byref', 'default', 'erase',
    'let', 'resume', 'stop', 'get', 'len', 'mid', 'left',
    'right', 'trim', 'replace', 'split', 'join', 'filter', 'string',
    'space', 'chr', 'asc', 'int', 'fix', 'abs', 'sgn',
    'sqr', 'exp', 'log', 'sin', 'cos', 'tan', 'atn',
    'round', 'rnd', 'array', 'date', 'time', 'now', 'timer',
    'year', 'month', 'day', 'weekday', 'hour', 'minute', 'second',
    'response', 'request', 'server', 'session', 'application',
].sort((a, b) => b.length - a.length);

// Pre-compile all regexes once at module load.
// A key may span words, the way the keyword regexes already allow, so a
// multi-word form can override the generic title-caser — `On Error GoTo 0`
// would otherwise come back out as `On Error Goto 0`.
const PROPER_CASING_REGEXES = Object.entries(PROPER_CASING_MAP).map(([lower, proper]) => ({
    re: new RegExp('\\b' + lower.replace(/\s+/g, '\\s+') + '\\b', 'gi'),
    replacement: proper,
}));

// Anchored on a preceding dot, so only a member access is touched. `rs.MoveNext`
// is cased; `Dim movenext` is the author's variable and is left alone.
const MEMBER_CASING_REGEXES = Object.entries(MEMBER_CASING_MAP).map(([lower, proper]) => ({
    re: new RegExp('(?<=\\.)' + lower + '\\b', 'gi'),
    replacement: proper,
}));

const VBSCRIPT_FUNCTION_REGEXES = Object.entries(VBSCRIPT_FUNCTIONS_MAP).map(([lower, proper]) => ({
    re: new RegExp('\\b' + lower + '\\b', 'gi'),
    replacement: proper,
}));

const HANDLED_KEYWORDS = new Set([
    ...Object.keys(VBSCRIPT_FUNCTIONS_MAP),
    ...Object.keys(PROPER_CASING_MAP),
]);

const KEYWORD_REGEXES = KEYWORDS_SORTED.map(kw => ({
    kw,
    re: new RegExp('\\b' + kw.replace(/\s+/g, '\\s+') + '\\b', 'gi'),
}));

export function applyKeywordCase(code: string, caseStyle: string): string {
    // Split off a trailing VBScript comment FIRST — keyword casing and operator/
    // comma spacing must never touch comment text. Previously a comment such as
    // `' loop through next items` was keyword-cased to `' Loop through Next items`
    // and a URL like `' see http://x/y` became `' see http: / / x/y`.
    const { code: codeOnly, comment } = splitOffComment(code);
    const formatted = splitByStrings(codeOnly).map(part => {
        if (part.isString) return part.text;
        let s = applyKeywordCaseToText(part.text, caseStyle);
        s = formatOperators(s);
        s = formatCommas(s);
        return s;
    }).join('');
    return formatted + comment;
}

function applyKeywordCaseToText(text: string, caseStyle: string): string {
    let result = text;

    if (caseStyle === 'PascalCase') {
        for (const { re, replacement } of PROPER_CASING_REGEXES) {
            result = result.replace(re, replacement);
        }
        for (const { re, replacement } of MEMBER_CASING_REGEXES) {
            result = result.replace(re, replacement);
        }
    }

    for (const { re, replacement } of VBSCRIPT_FUNCTION_REGEXES) {
        result = result.replace(re, replacement);
    }

    for (const { kw, re } of KEYWORD_REGEXES) {
        if (HANDLED_KEYWORDS.has(kw.toLowerCase())) continue;
        result = result.replace(re, m => formatKeyword(m, caseStyle));
    }

    return result;
}

function formatKeyword(keyword: string, caseStyle: string): string {
    switch (caseStyle) {
        case 'lowercase': return keyword.toLowerCase();
        case 'UPPERCASE': return keyword.toUpperCase();
        default: return keyword.split(' ')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
    }
}

// ─── Operator / comma formatting ───────────────────────────────────────────

/**
 * Like splitByStrings, but also marks VBScript literals that must never be
 * operator/comma-spaced as opaque: `#…#` date/time literals and `&H…`/`&O…`
 * hex/octal numbers (with an optional trailing `&` long-type suffix). Prevents
 * `x = &H1F` → `x = & H1F` and `d = #12/25/2024#` → `d = #12 / 25 / 2024#`.
 */
function splitOpaque(code: string): Array<{ text: string; opaque: boolean }> {
    const parts: Array<{ text: string; opaque: boolean }> = [];
    let buf = '';
    const flush = () => { if (buf) { parts.push({ text: buf, opaque: false }); buf = ''; } };

    let i = 0;
    while (i < code.length) {
        const ch = code[i];

        // String literal "…"  ("" escapes a quote)
        if (ch === '"') {
            flush();
            let j = i + 1;
            while (j < code.length) {
                if (code[j] === '"') {
                    if (code[j + 1] === '"') { j += 2; continue; }
                    j++;
                    break;
                }
                j++;
            }
            parts.push({ text: code.slice(i, j), opaque: true });
            i = j;
            continue;
        }

        // Date/time literal #…#
        if (ch === '#') {
            const end = code.indexOf('#', i + 1);
            if (end !== -1) {
                flush();
                parts.push({ text: code.slice(i, end + 1), opaque: true });
                i = end + 1;
                continue;
            }
        }

        // Hex/octal literal &H.. / &O.. (optional trailing & long-type suffix)
        if (ch === '&' && /[HhOo]/.test(code[i + 1] ?? '')) {
            const m = /^&[HhOo][0-9A-Fa-f]+&?/.exec(code.slice(i));
            if (m) {
                flush();
                parts.push({ text: m[0], opaque: true });
                i += m[0].length;
                continue;
            }
        }

        const prevCh = i > 0 ? code[i - 1] : '';

        // A number with an exponent — 1.5E-3, 2E+10, .5E-2 — is one literal, sign
        // and all. Spaced as an operator it became `1.5E - 3`, and `1.5E` is not a
        // number, so the page failed to compile.
        const startsNumber = /[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] ?? ''));
        if (startsNumber && !/[\w.]/.test(prevCh)) {
            const m = /^(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+/.exec(code.slice(i));
            if (m) {
                flush();
                parts.push({ text: m[0], opaque: true });
                i += m[0].length;
                continue;
            }
        }

        // Decimal literal with a trailing & Long-type suffix (e.g. 100&). Keep the
        // & attached so it isn't spaced as a concatenation operator (100 &). Only
        // matched at a token start so a concatenation like `100 & x` is untouched.
        if (/[0-9]/.test(ch) && !/[\w.]/.test(prevCh)) {
            const m = /^\d+&/.exec(code.slice(i));
            if (m) {
                flush();
                parts.push({ text: m[0], opaque: true });
                i += m[0].length;
                continue;
            }
        }

        buf += ch;
        i++;
    }
    flush();
    return parts;
}

/** Keywords that are followed by an expression, so a `-` after one is a sign. */
const UNARY_MINUS_AFTER = new Set([
    'step', 'to', 'case', 'if', 'then', 'else', 'elseif', 'while', 'until',
    'and', 'or', 'not', 'xor', 'eqv', 'imp', 'mod', 'is',
]);

function formatOperators(code: string): string {
    return splitOpaque(code).map(part =>
        part.opaque ? part.text : formatOperatorsInText(part.text)
    ).join('');
}

/**
 * Adds spacing around binary operators only.
 *
 * Key rules to avoid false positives:
 *  - `=` in an assignment/comparison gets spaces, but we don't touch `<=` `>=` `<>`
 *    (those are handled first as compound operators).
 *  - `-` only gets spaces when it's BINARY (preceded by an identifier, digit,
 *    closing paren/bracket, or `_`). Unary minus (after `=`, `(`, `,`,
 *    operator, or start-of-expression) is left alone.
 *  - `+` is safe to always space since VBScript has no unary + ambiguity
 *    that matters in practice.
 *  - `*` `/` `&` are always binary so always get spaces.
 *  - `<` `>` are handled last, skipping already-processed compound pairs.
 */
function formatOperatorsInText(text: string): string {
    let r = text;

    // ── Compound operators first (must precede single-char rules) ──────────
    r = r.replace(/\s*<>\s*/g,  ' <> ');
    r = r.replace(/\s*<=\s*/g,  ' <= ');
    r = r.replace(/\s*>=\s*/g,  ' >= ');

    // ── Assignment / comparison = ───────────────────────────────────────────
    // Skip when already part of <> <= >=  (already replaced above).
    r = r.replace(/(?<![<>!])\s*=\s*(?![>])/g, ' = ');

    // ── Binary + ────────────────────────────────────────────────────────────
    r = r.replace(/\s*\+\s*/g, ' + ');

    // ── Binary - only (not unary) ───────────────────────────────────────────
    // A binary minus is preceded by an operand: a word char, digit, `)`, `]`
    // or `_`. A keyword that expects an expression is not an operand, so the
    // minus after it is unary and stays against its operand — `Step -1`,
    // `Case -1`, `And -b`. That also mends the `Step - 1` older versions wrote.
    r = r.replace(/([\w\d\)_\]])\s*-\s*/g, (_m, before: string, offset: number) => {
        const word = /\w*$/.exec(r.slice(0, offset + 1))![0].toLowerCase();
        return UNARY_MINUS_AFTER.has(word) ? `${before} -` : `${before} - `;
    });

    // ── * / \ ^ & ─────────────────────────────────────────────────────────────
    // `\` is integer division and `^` is exponentiation — both always binary.
    r = r.replace(/\s*\*\s*/g, ' * ');
    r = r.replace(/\s*\/\s*/g, ' / ');
    r = r.replace(/\s*\\\s*/g, ' \\ ');
    r = r.replace(/\s*\^\s*/g, ' ^ ');
    r = r.replace(/\s*&\s*/g,  ' & ');

    // ── < > (skip already-processed compounds) ──────────────────────────────
    r = r.replace(/(?<![<>])\s*<\s*(?![>=])/g, ' < ');
    r = r.replace(/(?<![<>])\s*>\s*(?![=])/g,  ' > ');

    // ── Collapse any accidental double-spaces created above ─────────────────
    r = r.replace(/  +/g, ' ');

    return r;
}

function formatCommas(code: string): string {
    return splitOpaque(code).map(part =>
        part.opaque ? part.text : part.text.replace(/,(?!\s)/g, ', ')
    ).join('');
}