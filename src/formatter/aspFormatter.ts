import * as vscode from 'vscode';

// ─── Settings ──────────────────────────────────────────────────────────────

export interface AspFormatterSettings {
    keywordCase:       string;   // 'lowercase' | 'UPPERCASE' | 'PascalCase'
    useTabs:           boolean;
    indentSize:        number;
    aspTagsOnSameLine: boolean;
    htmlIndentMode:    string;   // 'flat' | 'continuation'
}

export function getAspSettings(): AspFormatterSettings {
    const config = vscode.workspace.getConfiguration('aspLanguageSupport');
    return {
        keywordCase:       config.get<string>('keywordCase',       'PascalCase'),
        useTabs:           config.get<boolean>('useTabs',          false),
        indentSize:        config.get<number>('indentSize',        2),
        aspTagsOnSameLine: config.get<boolean>('aspTagsOnSameLine', false),
        htmlIndentMode:    config.get<string>('htmlIndentMode',    'flat'),
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
 *                      placeholder comment — used only when htmlIndentMode
 *                      is 'continuation'.
 * @param startLevel    VBScript indent level inherited from the previous block.
 */
export function formatSingleAspBlock(
    block:      string,
    settings:   AspFormatterSettings,
    htmlIndent: string = '',
    startLevel: number = 0,
): FormatBlockResult {

    const trimmedBlock = block.trim();

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
        const levelBefore = applyIndentBefore(content, startLevel, selectCaseStack).level;
        const levelAfter  = applyIndentAfter(content, levelBefore, selectCaseStack);

        if (settings.aspTagsOnSameLine) {
            return {
                formatted: '<% ' + formattedContent + ' %>',
                endLevel:  levelAfter,
            };
        }

        const aspIndent = getIndentString(levelBefore, settings.useTabs, settings.indentSize);
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

    // In 'flat' mode the VBScript base indent is always 0.
    // In 'continuation' mode it starts at the HTML depth inferred from htmlIndent.
    const baseLevel = settings.htmlIndentMode === 'continuation'
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
                aspIndentLevel     = applyIndentBefore(content, aspIndentLevel, selectCaseStack).level;
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

                aspIndentLevel = applyIndentAfter(content, aspIndentLevel, selectCaseStack);
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
                aspIndentLevel     = applyIndentBefore(content, aspIndentLevel, selectCaseStack).level;
                const aspIndent    = getIndentString(baseLevel + aspIndentLevel, settings.useTabs, settings.indentSize);
                const formatted    = applyKeywordCase(content, settings.keywordCase);

                if (settings.aspTagsOnSameLine) {
                    formattedLines.push(aspIndent + formatted + ' %>');
                } else {
                    formattedLines.push(aspIndent + formatted);
                    formattedLines.push('%>');
                }

                aspIndentLevel = applyIndentAfter(content, aspIndentLevel, selectCaseStack);
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
        if (prevHadContinuation && trimmed.startsWith('"')) {
            if (isInSQLBlock) {
                const originalIndent = raw.length - raw.trimStart().length;
                const relativeIndent = originalIndent - sqlBaseIndent;
                const extraLevel     = relativeIndent > 0 ? 1 : 0;
                const aspIndent      = getIndentString(baseLevel + aspIndentLevel + 1 + extraLevel, settings.useTabs, settings.indentSize);
                formattedLines.push(aspIndent + trimmed);
            } else if (continuationAlignCol === -1) {
                const aspIndent = getIndentString(baseLevel + aspIndentLevel + 1, settings.useTabs, settings.indentSize);
                formattedLines.push(aspIndent + trimmed);
            } else {
                formattedLines.push(' '.repeat(continuationAlignCol) + trimmed);
            }

            if (!trimmed.trimEnd().endsWith('_')) {
                prevHadContinuation = false;
                inMultilineString   = false;
                isInSQLBlock        = false;
            }
            continue;
        }

        // ── Normal VBScript line ─────────────────────────────────────────
        aspIndentLevel          = applyIndentBefore(trimmed, aspIndentLevel, selectCaseStack).level;
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
        aspIndentLevel = applyIndentAfter(trimmed, aspIndentLevel, selectCaseStack);
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
function applyIndentBefore(
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
function applyIndentAfter(
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
 * Strips string literals AND VBScript comment tails from a line so that
 * keyword matching in applyIndentBefore / applyIndentAfter never fires on
 * text inside a comment.  e.g.  `x = 1 ' End With`  →  `x = 1 `
 */
function removeStrings(line: string): string {
    let result   = '';
    let inString = false;

    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') {
            // "" is an escaped quote inside a string — skip both chars.
            if (i + 1 < line.length && line[i + 1] === '"') { i++; continue; }
            inString = !inString;
        } else if (!inString) {
            // VBScript comment — everything from here to EOL is non-code.
            if (line[i] === "'") { break; }
            result += line[i];
        }
    }

    return result;
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

// ─── Keyword casing ────────────────────────────────────────────────────────

// Multi-word and special-cased keywords that need exact casing.
const PROPER_CASING_MAP: Record<string, string> = {
    'elseif': 'ElseIf', 'redim': 'ReDim', 'byval': 'ByVal', 'byref': 'ByRef',
    'isnull': 'IsNull', 'isempty': 'IsEmpty', 'isnumeric': 'IsNumeric',
    'isarray': 'IsArray', 'isobject': 'IsObject', 'isdate': 'IsDate',
    'readonly': 'ReadOnly', 'writeonly': 'WriteOnly', 'typename': 'TypeName',
    'vartype': 'VarType', 'getobject': 'GetObject', 'createobject': 'CreateObject',
    'getref': 'GetRef', 'endif': 'EndIf', 'endsub': 'EndSub',
    'endfunction': 'EndFunction', 'endwith': 'EndWith', 'endselect': 'EndSelect',
    'endclass': 'EndClass', 'endproperty': 'EndProperty', 'exitfor': 'ExitFor',
    'exitdo': 'ExitDo', 'exitsub': 'ExitSub', 'exitfunction': 'ExitFunction',
    'exitproperty': 'ExitProperty', 'onerror': 'OnError',
    'querystring': 'QueryString', 'servervariables': 'ServerVariables',
    'totalbytes': 'TotalBytes', 'binaryread': 'BinaryRead',
    'clientcertificate': 'ClientCertificate', 'contenttype': 'ContentType',
    'addheader': 'AddHeader', 'appendtolog': 'AppendToLog',
    'binarywrite': 'BinaryWrite', 'cacheecontrol': 'CacheControl',
    'clearheaders': 'ClearHeaders',
    'contentlength': 'ContentLength',
    'expiresabsolute': 'ExpiresAbsolute', 'isclientconnected': 'IsClientConnected',
    'pics': 'PICS', 'mappath': 'MapPath',
    'scripttimeout': 'ScriptTimeout', 'htmlencode': 'HTMLEncode',
    'urlencode': 'URLEncode', 'createtextfile': 'CreateTextFile',
    'opentextfile': 'OpenTextFile', 'getlasterror': 'GetLastError',
    'sessionid': 'SessionID', 'codepage': 'CodePage',
    'lcid': 'LCID', 'filesystemobject': 'FileSystemObject',
    'getfile': 'GetFile', 'getfolder': 'GetFolder', 'getdrive': 'GetDrive',
    'fileexists': 'FileExists', 'folderexists': 'FolderExists',
    'driveexists': 'DriveExists', 'getfilename': 'GetFileName',
    'getbasename': 'GetBaseName', 'getextensionname': 'GetExtensionName',
    'getparentfoldername': 'GetParentFolderName', 'getdrivename': 'GetDriveName',
    'getabsolutepathname': 'GetAbsolutePathName', 'buildpath': 'BuildPath',
    'getspecialfolder': 'GetSpecialFolder', 'gettempname': 'GetTempName',
    'deletefile': 'DeleteFile', 'deletefolder': 'DeleteFolder',
    'movefile': 'MoveFile', 'movefolder': 'MoveFolder',
    'copyfile': 'CopyFile', 'copyfolder': 'CopyFolder', 'createfolder': 'CreateFolder',
    'writeline': 'WriteLine', 'writeblanklines': 'WriteBlankLines',
    'readline': 'ReadLine', 'readall': 'ReadAll', 'atendofstream': 'AtEndOfStream',
    'atendofline': 'AtEndOfLine', 'skipline': 'SkipLine', 'closetext': 'CloseText',
    'datelastmodified': 'DateLastModified', 'datelastaccessed': 'DateLastAccessed',
    'datecreated': 'DateCreated', 'parentfolder': 'ParentFolder',
    'shortname': 'ShortName', 'shortpath': 'ShortPath', 'rootfolder': 'RootFolder',
    'recordset': 'Recordset', 'movenext': 'MoveNext', 'movefirst': 'MoveFirst',
    'movelast': 'MoveLast', 'moveprevious': 'MovePrevious', 'addnew': 'AddNew',
    'recordcount': 'RecordCount', 'pagesize': 'PageSize', 'pagecount': 'PageCount',
    'absolutepage': 'AbsolutePage', 'absoluteposition': 'AbsolutePosition',
    'cursortype': 'CursorType', 'cursorlocation': 'CursorLocation',
    'locktype': 'LockType', 'commandtext': 'CommandText', 'commandtype': 'CommandType',
    'connectionstring': 'ConnectionString', 'begintrans': 'BeginTrans',
    'committrans': 'CommitTrans', 'rollbacktrans': 'RollbackTrans',
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
    'if', 'then', 'else', 'elseif', 'end if', 'select case', 'case', 'case else',
    'end select', 'for', 'to', 'step', 'next', 'for each', 'in', 'while', 'wend',
    'do', 'loop', 'until', 'exit do', 'exit for', 'sub', 'end sub', 'function',
    'end function', 'call', 'exit sub', 'exit function', 'dim', 'redim', 'preserve',
    'const', 'private', 'public', 'static', 'class', 'end class', 'new', 'set',
    'property get', 'property let', 'property set', 'end property',
    'on error resume next', 'on error goto 0', 'err', 'error',
    'and', 'or', 'not', 'xor', 'eqv', 'imp', 'is', 'like',
    'nothing', 'null', 'empty', 'true', 'false',
    'option explicit', 'randomize', 'with', 'end with', 'exit', 'mod',
    'byval', 'byref', 'default', 'erase', 'let', 'resume', 'stop', 'get', 'put',
    'open', 'close', 'input', 'output', 'append', 'binary', 'random', 'as',
    'len', 'mid', 'left', 'right', 'trim', 'replace', 'split', 'join', 'filter',
    'string', 'space', 'chr', 'asc', 'int', 'fix', 'abs', 'sgn', 'sqr', 'exp',
    'log', 'sin', 'cos', 'tan', 'atn', 'round', 'rnd',
    'array', 'date', 'time', 'now', 'timer',
    'year', 'month', 'day', 'weekday', 'hour', 'minute', 'second',
    'response', 'request', 'server', 'session', 'application',
    'write', 'redirect', 'querystring', 'form', 'servervariables',
    'cookies', 'mappath', 'createtextfile', 'opentextfile', 'writeline',
    'readline', 'readall', 'atendofstream', 'filesystemobject', 'scripting',
    'dictionary', 'add', 'exists', 'items', 'keys', 'remove', 'removeall',
    'count', 'item', 'key',
].sort((a, b) => b.length - a.length);

// Pre-compile all regexes once at module load.
const PROPER_CASING_REGEXES = Object.entries(PROPER_CASING_MAP).map(([lower, proper]) => ({
    re: new RegExp('\\b' + lower + '\\b', 'gi'),
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

function applyKeywordCase(code: string, caseStyle: string): string {
    return splitByStrings(code).map(part => {
        if (part.isString) return part.text;
        let s = applyKeywordCaseToText(part.text, caseStyle);
        s = formatOperators(s);
        s = formatCommas(s);
        return s;
    }).join('');
}

function applyKeywordCaseToText(text: string, caseStyle: string): string {
    let result = text;

    if (caseStyle === 'PascalCase') {
        for (const { re, replacement } of PROPER_CASING_REGEXES) {
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

function formatOperators(code: string): string {
    return splitByStrings(code).map(part =>
        part.isString ? part.text : formatOperatorsInText(part.text)
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
    // A binary minus is preceded by: word char, digit, `)`, `]`, `_`.
    // We require at least one optional space on each side, then replace.
    r = r.replace(/([\w\d\)_\]])\s*-\s*/g, '$1 - ');

    // ── * / & ────────────────────────────────────────────────────────────────
    r = r.replace(/\s*\*\s*/g, ' * ');
    r = r.replace(/\s*\/\s*/g, ' / ');
    r = r.replace(/\s*&\s*/g,  ' & ');

    // ── < > (skip already-processed compounds) ──────────────────────────────
    r = r.replace(/(?<![<>])\s*<\s*(?![>=])/g, ' < ');
    r = r.replace(/(?<![<>])\s*>\s*(?![=])/g,  ' > ');

    // ── Collapse any accidental double-spaces created above ─────────────────
    r = r.replace(/  +/g, ' ');

    return r;
}

function formatCommas(code: string): string {
    return splitByStrings(code).map(part =>
        part.isString ? part.text : part.text.replace(/,(?!\s)/g, ', ')
    ).join('');
}