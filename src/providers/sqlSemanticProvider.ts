import * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────────────────────
// Semantic token legend — MUST be the same object used by jsSemanticProvider.ts
// and registered in extension.ts (COMBINED_SEMANTIC_LEGEND).
//
// VS Code maps token type indices through whichever legend it sees first for a
// given language ID. If the ASP provider uses a different legend than the JS
// provider the indices will be decoded against the wrong legend and every
// VBScript colour will be wrong.
//
// Layout (index order matters — must match COMBINED_SEMANTIC_LEGEND exactly):
//
// Standard VS Code token types (indices 0–22, from jsSemanticProvider.ts):
//   0  namespace
//   1  type
//   2  class
//   3  enum
//   4  interface
//   5  struct
//   6  typeParameter
//   7  parameter
//   8  variable
//   9  property
//  10  enumMember
//  11  event
//  12  function
//  13  method
//  14  macro
//  15  keyword
//  16  modifier
//  17  comment
//  18  string
//  19  number
//  20  regexp
//  21  operator
//  22  decorator
//
// ASP/SQL-specific token types appended after the standard ones (indices 23–34):
//  23  sqlDml           → SELECT, INSERT, UPDATE, DELETE, FROM, WHERE, JOIN …
//  24  sqlDdl           → CREATE, DROP, ALTER, TABLE …
//  25  sqlLogical       → AND, OR, NOT, IN, IS, LIKE, BETWEEN, EXISTS …
//  26  sqlKeyword       → AS, SET, VALUES, CASE, WHEN, THEN, BEGIN, DECLARE …
//  27  sqlFunction      → COUNT, SUM, AVG, CONVERT, GETDATE, ISNULL …
//  28  sqlType          → VARCHAR, INT, DATETIME, BIT …
//  29  sqlVariable      → @paramName
//  30  sqlNumber        → numeric literals  1, 42, 3.14 …
//  31  sqlBracketPunct  → the [ and ] characters
//  32  sqlBracketContent → text inside [brackets] AND bare-word table names/aliases
//  33  sqlTable         → left-hand side of table.column dot refs / bare-word table names
//  34  sqlColumn        → right-hand side of alias.column  e.g. "RowID" in u.RowID
//
// Token modifiers (must match COMBINED_SEMANTIC_LEGEND):
//   0  declaration
//   1  definition
//   2  readonly
//   3  static
//   4  deprecated
//   5  abstract
//   6  async
//   7  modification
//   8  documentation
//   9  defaultLibrary
// ─────────────────────────────────────────────────────────────────────────────
export const ASP_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
    [
        // Standard VS Code types — indices 0–22 (must mirror TOKEN_TYPES in jsSemanticProvider.ts)
        'namespace', 'type', 'class', 'enum', 'interface', 'struct',
        'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
        'event', 'function', 'method', 'macro', 'keyword', 'modifier',
        'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
        // ASP/SQL-specific types — indices 23–34
        'sqlDml', 'sqlDdl', 'sqlLogical', 'sqlKeyword', 'sqlFunction', 'sqlType', 'sqlVariable',
        'sqlNumber', 'sqlBracketPunct', 'sqlBracketContent', 'sqlTable', 'sqlColumn',
    ],
    // Modifiers must also mirror TOKEN_MODIFIERS in jsSemanticProvider.ts
    [
        'declaration', 'definition', 'readonly', 'static', 'deprecated',
        'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
    ]
);

// ── VBScript token type indices (positions within COMBINED_SEMANTIC_LEGEND) ──
// These map to the standard VS Code token types by name, so the editor theme
// colours VBScript identifiers the same way it would colour the equivalent
// concept in TypeScript/JavaScript.
export const T_FUNCTION         = 12; // 'function'   — user-defined Function names
export const T_NAMESPACE        = 0;  // 'namespace'  — user-defined Sub names
export const T_VARIABLE         = 8;  // 'variable'   — Dim'd variables and COM objects
export const T_PARAMETER        = 7;  // 'parameter'  — function/sub parameters
export const T_CONSTANT         = 10; // 'enumMember' — Const values

// ── SQL token type indices (appended after the 23 standard types) ────────────
const T_SQL_DML          = 23;
const T_SQL_DDL          = 24;
const T_SQL_LOGICAL      = 25;
const T_SQL_KEYWORD      = 26;
const T_SQL_FUNC         = 27;
const T_SQL_TYPE         = 28;
const T_SQL_VAR          = 29;
const T_SQL_NUMBER       = 30;
const T_SQL_BRACKET_PUNC = 31;
const T_SQL_BRACKET_CON  = 32;
// T_SQL_TABLE = 33 (unused directly; coloured via T_SQL_BRACKET_CON)
const T_SQL_COLUMN       = 34;

// ── Token modifier bit masks (positions within COMBINED_SEMANTIC_LEGEND) ─────
// 'declaration' is at index 0 → bit 1<<0 = 1
// 'readonly'    is at index 2 → bit 1<<2 = 4
export const M_DECLARATION = 1 << 0; // 1
export const M_READONLY    = 1 << 2; // 4

// ─────────────────────────────────────────────────────────────────────────────
// SQL detection — requires BOTH a DML/DDL verb AND a clause keyword.
// Guard: FROM followed by an English article (the/a/an/this/that/my/your etc.)
// is plain English, not SQL — e.g. "Select an option from the list".
// ─────────────────────────────────────────────────────────────────────────────
const SQL_VERBS   = /\b(SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE|CREATE|DROP|ALTER|TRUNCATE|MERGE)\b/i;
const SQL_CLAUSES = /\b(FROM|INTO|TABLE|SET|VALUES|WHERE|JOIN|UNION|HAVING|GROUP\s+BY|ORDER\s+BY|RETURNING|DECLARE|BEGIN\s+TRAN|COMMIT|ROLLBACK|USING|WHEN\s+MATCHED|WHEN\s+NOT\s+MATCHED)\b/i;
const ENGLISH_ARTICLES = /^(the|a|an|this|that|these|those|my|your|our|their|its|her|his)$/i;

export function isSql(text: string): boolean {
    if (!SQL_VERBS.test(text) || !SQL_CLAUSES.test(text)) { return false; }

    // Strip SQL single-quoted string literals before applying prose guards.
    // This prevents content like 'TOOL_ID:' or 'TOOL_INFO' inside SQL string
    // parameters from triggering the colon/period guards.
    const textNoStrings = text.replace(/'(?:[^']|'')*'/g, m => ' '.repeat(m.length));

    // Guard: a period that is NOT between two word characters (i.e. not a.b dot notation)
    // AND NOT between ] and [ (i.e. not [db].[schema].[table] bracket notation)
    // appearing BEFORE the first SQL clause keyword means this is a sentence, not SQL.
    // e.g. "Daily total hours (12 hrs) exceeds limit. Base: ..." has a prose period.
    const firstClauseMatch = SQL_CLAUSES.exec(textNoStrings);
    if (firstClauseMatch) {
        const beforeClause = textNoStrings.slice(0, firstClauseMatch.index);
        if (/(?<![\w\]])\.|\.(?![\w\[*])/.test(beforeClause)) { return false; }
    }

    // Guard: a colon that follows a word and is NOT immediately followed by a digit
    // (time like 7:30), ( or / means this is an error/label string, not SQL.
    // Real SQL strings never contain word: patterns outside of string literals.
    // e.g. "Delete from OT_Authorise failed: " — the trailing colon gives it away.
    if (/\w\s*:(?!\s*[\d/()])/.test(textNoStrings)) { return false; }

    const fromMatch = textNoStrings.match(/\bFROM\s+(\w+)/i);
    if (fromMatch && ENGLISH_ARTICLES.test(fromMatch[1])) {
        const withoutFrom = textNoStrings.replace(/\bFROM\s+\w+/gi, '');
        if (!SQL_CLAUSES.test(withoutFrom)) { return false; }
    }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL expression fragment detection — for strings that are pure SQL expressions
// (SUBSTRING, CHARINDEX, CAST, etc.) with no SELECT/FROM verb.
// Used to detect variables like anpQRAssort = "LTRIM(RTRIM(SUBSTRING(...)))"
// that get embedded as fragments into a larger SQL string.
// ─────────────────────────────────────────────────────────────────────────────
const SQL_EXPR_FUNCTIONS = /\b(SUBSTRING|CHARINDEX|PATINDEX|LEN|LTRIM|RTRIM|TRIM|UPPER|LOWER|REPLACE|STUFF|LEFT|RIGHT|REVERSE|CAST|CONVERT|ISNULL|COALESCE|NULLIF|IIF|CHOOSE|DATEADD|DATEDIFF|DATEPART|DATENAME|GETDATE|GETUTCDATE|FORMAT|TRY_CAST|TRY_CONVERT|COUNT|SUM|AVG|MAX|MIN|ROW_NUMBER|RANK|DENSE_RANK|ABS|CEILING|FLOOR|ROUND|POWER|SQRT|YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)\s*\(/i;

// Returns true for strings that are SQL expressions (function calls) even
// without a SELECT/FROM verb — e.g. "LTRIM(RTRIM(SUBSTRING(QRCode, ...)))"
export function isSqlExpression(text: string): boolean {
    // Must start with a SQL function call (possibly with leading whitespace)
    if (!SQL_EXPR_FUNCTIONS.test(text)) { return false; }
    // Must not look like a natural language sentence (has a period before any keyword)
    if (/(?<![\w\]])\.|\.(?![\w\[*])/.test(text.split('(')[0])) { return false; }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL keyword sets — mirrors tmLanguage sql-syntax scopes for consistent colours.
// ─────────────────────────────────────────────────────────────────────────────
const SQL_DML_WORDS = new Set([
    'select','insert','update','delete','merge','output','exec','execute',
    'from','where','join','on','using','having','distinct','top','limit',
    'offset','fetch','union','intersect','except','by','order','group',
    'apply','matched','ties','with',
    'left','right','inner','outer','full','cross',
    'partition','over',
]);
const SQL_DDL_WORDS = new Set([
    'create','drop','alter','truncate','add','table','index','view',
    'database','procedure','function','trigger','schema',
]);
const SQL_LOGICAL_WORDS = new Set([
    'and','or','not','in','is','like','between','exists','any','all','some',
]);
const SQL_KEYWORD_WORDS = new Set([
    'as','asc','desc','set','values','into','case','when','then','else','end',
    'nolock','default','constraint','primary','foreign','key','unique',
    'references','check','collate','begin','commit','rollback','transaction',
    'declare','cursor','open','close','deallocate','if','print','raiserror',
    'go','identity','null','returning',
    'current_timestamp','hour','minute','second','millisecond',
    'microsecond','nanosecond','dayofweek','dayofyear','week','weekday','quarter',
]);
const SQL_FUNCTION_WORDS = new Set([
    'count','sum','avg','max','min','row_number','rank','dense_rank','ntile',
    'lead','lag','first_value','last_value',
    'substring','len','length','upper','lower','trim','ltrim','rtrim','concat',
    'concat_ws','replace','charindex','patindex','stuff','left','right',
    'reverse','replicate','space','soundex','difference','ascii','char',
    'nchar','unicode','quotename',
    'getdate','getutcdate','sysdatetime','sysutcdatetime','sysdatetimeoffset',
    'dateadd','datediff','datediff_big','datepart',
    'datename','year','month','day','convert','cast','format','try_cast','try_convert','parse',
    'try_parse','eomonth','datefromparts','datetime2fromparts',
    'datetimefromparts','datetimeoffsetfromparts','smalldatetimefromparts',
    'timefromparts','isdate',
    'abs','ceiling','floor','round','power','sqrt','exp','log','log10','pi',
    'sin','cos','tan','asin','acos','atan','atn2','degrees','radians','sign',
    'rand','square',
    'isnull','coalesce','nullif','ifnull','iif','choose',
]);
const SQL_TYPE_WORDS = new Set([
    'varchar','nvarchar','char','nchar','text','ntext','int','integer','bigint',
    'smallint','tinyint','decimal','numeric','float','real','money','smallmoney',
    'bit','date','datetime','datetime2','smalldatetime','time','datetimeoffset',
    'timestamp','uniqueidentifier','guid','xml','varbinary','binary','image',
    'sql_variant','hierarchyid','geometry','geography',
]);

// Combined set — prevents bare words from being mistaken for table names.
export const ALL_SQL_KEYWORDS = new Set([
    ...SQL_DML_WORDS, ...SQL_DDL_WORDS, ...SQL_LOGICAL_WORDS,
    ...SQL_KEYWORD_WORDS, ...SQL_FUNCTION_WORDS, ...SQL_TYPE_WORDS,
    'temp','temporary','exists','table',
]);

// Precomputed word→tokenType map for O(1) lookup instead of 6 sequential Set checks.
const SQL_WORD_TOKEN_MAP = new Map<string, number>();
for (const w of SQL_DML_WORDS)      { SQL_WORD_TOKEN_MAP.set(w, T_SQL_DML); }
for (const w of SQL_DDL_WORDS)      { SQL_WORD_TOKEN_MAP.set(w, T_SQL_DDL); }
for (const w of SQL_LOGICAL_WORDS)  { SQL_WORD_TOKEN_MAP.set(w, T_SQL_LOGICAL); }
for (const w of SQL_KEYWORD_WORDS)  { SQL_WORD_TOKEN_MAP.set(w, T_SQL_KEYWORD); }
for (const w of SQL_FUNCTION_WORDS) { SQL_WORD_TOKEN_MAP.set(w, T_SQL_FUNC); }
for (const w of SQL_TYPE_WORDS)     { SQL_WORD_TOKEN_MAP.set(w, T_SQL_TYPE); }

function sqlWordTokenType(word: string): number | undefined {
    return SQL_WORD_TOKEN_MAP.get(word.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL tokeniser — converts a raw SQL string into a flat token list.
// Each token has: type, value, and offset (position in the original string).
// Uses index-based scanning with pre-compiled sticky regexes to avoid
// repeated `str.slice(i).match(...)` allocations on every character.
// ─────────────────────────────────────────────────────────────────────────────
type SqlTokType = 'bracket' | 'word' | 'dot' | 'num' | 'comma' | 'paren' | 'ws' | 'other';
interface SqlTok { type: SqlTokType; val: string; off: number; }

// Sticky regexes — set .lastIndex = i before each exec() to avoid slice().
const RE_WORD  = /[a-zA-Z_#$][a-zA-Z0-9_#$]*/y;
const RE_NUM   = /\d+(\.\d+)?([eE][+-]?\d+)?/y;
const RE_WS    = /\s+/y;

function tokeniseSql(sql: string): SqlTok[] {
    const tokens: SqlTok[] = [];
    let i = 0;
    const len = sql.length;

    while (i < len) {
        const ch = sql[i];

        if (ch === '[') {
            const close = sql.indexOf(']', i);
            const end   = close === -1 ? len : close + 1;
            tokens.push({ type: 'bracket', val: sql.slice(i, end), off: i });
            i = end;
            continue;
        }

        RE_WORD.lastIndex = i;
        const wm = RE_WORD.exec(sql);
        if (wm) {
            tokens.push({ type: 'word', val: wm[0], off: i });
            i += wm[0].length;
            continue;
        }

        RE_NUM.lastIndex = i;
        const nm = RE_NUM.exec(sql);
        if (nm) {
            tokens.push({ type: 'num', val: nm[0], off: i });
            i += nm[0].length;
            continue;
        }

        if (ch === '.') { tokens.push({ type: 'dot',   val: ch, off: i++ }); continue; }
        if (ch === ',') { tokens.push({ type: 'comma', val: ch, off: i++ }); continue; }
        if (ch === '(' || ch === ')') { tokens.push({ type: 'paren', val: ch, off: i++ }); continue; }

        RE_WS.lastIndex = i;
        const sm = RE_WS.exec(sql);
        if (sm) {
            tokens.push({ type: 'ws', val: sm[0], off: i });
            i += sm[0].length;
            continue;
        }

        tokens.push({ type: 'other', val: ch, off: i++ });
    }
    return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context-aware table name detector.
// Scans the significant token stream and returns a Set of "off:len" strings
// for every range confirmed as a table name or alias.
//
// Detects names after: FROM, JOIN (all variants), INTO (INSERT INTO),
// UPDATE, TRUNCATE TABLE, ALTER TABLE, DROP TABLE [IF EXISTS],
// CREATE [TEMP|TEMPORARY] TABLE.
// WITH is excluded — the word after it is a CTE name, not a table.
// ─────────────────────────────────────────────────────────────────────────────
const JOIN_PREFIXES = new Set(['left','right','inner','outer','full','cross','natural']);
const TEMP_WORDS    = new Set(['temp','temporary']);

function matchTwoWordTableIntro(sig: SqlTok[], i: number): number {
    const w = sig[i].val.toLowerCase();
    if (i + 1 >= sig.length) { return -1; }
    const w2 = sig[i + 1].val.toLowerCase();

    if ((w === 'truncate' || w === 'alter') && w2 === 'table') { return i + 2; }

    if (w === 'drop' && w2 === 'table') {
        let j = i + 2;
        if (j < sig.length && sig[j].val.toLowerCase() === 'if')     { j++; }
        if (j < sig.length && sig[j].val.toLowerCase() === 'not')    { j++; }
        if (j < sig.length && sig[j].val.toLowerCase() === 'exists') { j++; }
        return j;
    }

    if (w === 'create') {
        let j = i + 1;
        if (j < sig.length && sig[j].val.toLowerCase() === 'table') { return j + 1; }
        if (j < sig.length && TEMP_WORDS.has(sig[j].val.toLowerCase())) {
            j++;
            if (j < sig.length && sig[j].val.toLowerCase() === 'table') { return j + 1; }
        }
    }
    return -1;
}

function isIdentifier(tok: SqlTok): boolean {
    return tok.type === 'bracket' || tok.type === 'word';
}

// Collect a dot-chain starting at sig[start] and optional alias after it.
function collectTableChain(sig: SqlTok[], start: number): Array<{off: number; len: number}> {
    const result: Array<{off: number; len: number}> = [];
    let i = start;

    if (i >= sig.length || !isIdentifier(sig[i])) { return result; }

    while (i < sig.length && isIdentifier(sig[i])) {
        const tok = sig[i];
        if (tok.type === 'bracket') {
            result.push({ off: tok.off, len: tok.val.length });
        } else {
            if (!ALL_SQL_KEYWORDS.has(tok.val.toLowerCase())) {
                result.push({ off: tok.off, len: tok.val.length });
            } else {
                break;
            }
        }
        i++;
        if (i < sig.length && sig[i].type === 'dot') { i++; } else { break; }
    }

    if (result.length === 0) { return result; }

    // Optional alias: AS <word>  or bare non-keyword word
    if (i < sig.length) {
        const tok = sig[i];
        if (tok.type === 'word' && tok.val.toLowerCase() === 'as') {
            i++;
            if (i < sig.length && sig[i].type === 'word' &&
                !ALL_SQL_KEYWORDS.has(sig[i].val.toLowerCase())) {
                result.push({ off: sig[i].off, len: sig[i].val.length });
            }
        } else if (tok.type === 'word' && !ALL_SQL_KEYWORDS.has(tok.val.toLowerCase())) {
            result.push({ off: tok.off, len: tok.val.length });
        }
    }

    return result;
}

// Main entry: returns a Set of "off:len" strings for fast membership testing.
function findTableRanges(sql: string): Set<string> {
    const all    = tokeniseSql(sql);
    const sig    = all.filter(t => t.type !== 'ws');
    const result = new Set<string>();

    function addRanges(ranges: Array<{off: number; len: number}>): void {
        for (const r of ranges) { result.add(`${r.off}:${r.len}`); }
    }

    let i = 0;
    while (i < sig.length) {
        const tok = sig[i];
        if (tok.type !== 'word') { i++; continue; }
        const w = tok.val.toLowerCase();

        const afterTwoWord = matchTwoWordTableIntro(sig, i);
        if (afterTwoWord !== -1) {
            addRanges(collectTableChain(sig, afterTwoWord));
            i = afterTwoWord + 1;
            continue;
        }

        // JOIN (optionally prefixed)
        if (JOIN_PREFIXES.has(w) && i + 1 < sig.length && sig[i+1].val.toLowerCase() === 'join') {
            i++; // advance past prefix to JOIN
        }
        const w2 = sig[i].val.toLowerCase();

        if (w2 === 'from' || w2 === 'join' || w2 === 'into' || w2 === 'update') {
            const next = i + 1;
            // Subquery: FROM/JOIN ( SELECT ... ) [AS] alias — skip the subquery
            // body and collect the alias after the closing ), e.g. ) b ON ...
            if (next < sig.length && sig[next].type === 'paren' && sig[next].val === '(') {
                let depth = 1;
                let j = next + 1;
                while (j < sig.length && depth > 0) {
                    if (sig[j].type === 'paren') { depth += sig[j].val === '(' ? 1 : -1; }
                    j++;
                }
                // j is now past the closing ) — look for optional AS then alias word
                if (j < sig.length && sig[j].type === 'word' && sig[j].val.toLowerCase() === 'as') {
                    j++;
                }
                if (j < sig.length && sig[j].type === 'word' &&
                    !ALL_SQL_KEYWORDS.has(sig[j].val.toLowerCase())) {
                    result.add(`${sig[j].off}:${sig[j].val.length}`);
                }
            } else {
                addRanges(collectTableChain(sig, next));
            }
        }

        // MERGE <table> AS alias
        if (w2 === 'merge') {
            addRanges(collectTableChain(sig, i + 1));
        }

        // USING (<subquery>) AS alias — skip the parenthesised subquery, then collect alias
        if (w2 === 'using') {
            let j = i + 1;
            if (j < sig.length && sig[j].type === 'paren' && sig[j].val === '(') {
                let depth = 1;
                j++;
                while (j < sig.length && depth > 0) {
                    if (sig[j].type === 'paren') {
                        depth += sig[j].val === '(' ? 1 : -1;
                    }
                    j++;
                }
                // j is now past the closing ')' — look for AS <alias> or bare alias
                if (j < sig.length && sig[j].type === 'word' && sig[j].val.toLowerCase() === 'as') {
                    j++;
                    if (j < sig.length && sig[j].type === 'word' &&
                        !ALL_SQL_KEYWORDS.has(sig[j].val.toLowerCase())) {
                        result.add(`${sig[j].off}:${sig[j].val.length}`);
                    }
                } else if (j < sig.length && sig[j].type === 'word' &&
                           !ALL_SQL_KEYWORDS.has(sig[j].val.toLowerCase())) {
                    result.add(`${sig[j].off}:${sig[j].val.length}`);
                }
            } else {
                addRanges(collectTableChain(sig, i + 1));
            }
        }

        i++;
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stitch & _ continuation lines and collect per-segment ranges.
// Returns null when the stitched string is not confirmed SQL.
// Also returns the stitched string and a per-character offset map so
// table ranges in the stitched string can be mapped back to document positions.
// ─────────────────────────────────────────────────────────────────────────────
export interface SqlStringSegment {
    lineIndex: number;
    lineText:  string;
    colStart:  number;
    colEnd:    number;
}
export interface SqlStringGroup {
    segments: SqlStringSegment[];
    stitched: string;
    omLine: Int32Array;  // offsetMap: line index per stitched char
    omCol:  Int32Array;  // offsetMap: column per stitched char
}

export function extractSqlGroup(
    document: vscode.TextDocument,
    startLine: number,
    startCol: number
): SqlStringGroup | null {

    const lineCount = document.lineCount;
    const segments: SqlStringSegment[] = [];
    let   stitched  = '';
    // offsetMap as two flat Int32Arrays — 10x less allocation than Array<{lineIndex,col}>.
    // We grow them lazily via a regular array of pairs, then convert at return time.
    const omLineArr: number[] = [];
    const omColArr:  number[] = [];

    function readFragment(lineText: string, col: number): {
        content: string; colStart: number; colEnd: number; nextCol: number;
        colOffsets: number[];
    } | null {
        if (col >= lineText.length || lineText[col] !== '"') { return null; }
        col++;
        const colStart = col;
        let content = '';
        const colOffsets: number[] = [];
        while (col < lineText.length) {
            if (lineText[col] === '"') {
                if (col + 1 < lineText.length && lineText[col + 1] === '"') {
                    colOffsets.push(col);
                    content += '"'; col += 2;
                } else { break; }
            } else {
                colOffsets.push(col);
                content += lineText[col++];
            }
        }
        if (col >= lineText.length) { return null; }
        return { content, colStart, colEnd: col, nextCol: col + 1, colOffsets };
    }

    function appendFragment(lineIndex: number, lineText: string, frag: {
        content: string; colStart: number; colEnd: number; colOffsets: number[];
    }): void {
        if (stitched.length > 0) {
            omLineArr.push(lineIndex); omColArr.push(frag.colStart);
            stitched += ' ';
        }
        for (const c of frag.colOffsets) {
            omLineArr.push(lineIndex); omColArr.push(c);
        }
        stitched += frag.content;
        segments.push({ lineIndex, lineText, colStart: frag.colStart, colEnd: frag.colEnd });
    }

    // Check if the rest of a line (after col) ends with & _
    function lineEndsWithContinuation(lineText: string, col: number): boolean {
        // Scan backwards from end of trimmed line, skipping any ' comment first
        let end = lineText.length - 1;
        while (end >= col && (lineText[end] === ' ' || lineText[end] === '\t')) { end--; }
        // Check for _
        if (end < col || lineText[end] !== '_') { return false; }
        end--;
        while (end >= col && (lineText[end] === ' ' || lineText[end] === '\t')) { end--; }
        return end >= col && lineText[end] === '&';
    }

    // Advance past & variable & gaps to find the next opening quote.
    // Handles:
    //   "sql" & _           → continuation to next line (caller handles)
    //   "sql" & varName & " → skip identifier between two & operators
    //   "sql" & fn(x) & "   → skip function call (depth-tracked parens)
    //   "sql" & "more"      → direct string concatenation
    function findNextQuote(lineText: string, col: number): number {
        while (col < lineText.length && lineText[col] <= ' ') { col++; }
        if (col < lineText.length && lineText[col] === '"') { return col; }
        if (col >= lineText.length || lineText[col] !== '&') { return -1; }
        col++; // skip the &

        while (col < lineText.length) {
            // Skip whitespace
            while (col < lineText.length && lineText[col] <= ' ') { col++; }
            if (col >= lineText.length) { return -1; }

            const ch = lineText[col];

            // Found a string — done
            if (ch === '"') { return col; }

            // Another & — continue looking (handles && gaps with no token between)
            if (ch === '&') { col++; continue; }

            // Line continuation _ — let outer loop handle the next line
            if (ch === '_') { return -1; }

            // VBScript comment — nothing more on this line
            if (ch === "'") { return -1; }

            // Identifier or function call (possibly with parens):
            //   varName, varName(args), Trim(x), obj.Method(x)
            // Skip past it including any parenthesised argument list.
            if (/[a-zA-Z_$]/.test(ch) || ch === '(') {
                let depth = 0;
                while (col < lineText.length) {
                    const c2 = lineText[col];
                    if (c2 === '(') { depth++; col++; continue; }
                    if (c2 === ')') {
                        depth--;
                        col++;
                        if (depth <= 0) { break; }
                        continue;
                    }
                    // At depth 0, stop on & (next operator), " (next string),
                    // _ (continuation), ' (comment), or line end.
                    if (depth === 0) {
                        if (c2 === '&' || c2 === '"' || c2 === '_' || c2 === "'") { break; }
                        // space before & — keep scanning
                        if (c2 <= ' ') { break; }
                    }
                    col++;
                }
                // After the identifier/call, expect whitespace then & then more
                while (col < lineText.length && lineText[col] <= ' ') { col++; }
                if (col < lineText.length && lineText[col] === '"') { return col; }
                if (col < lineText.length && lineText[col] === '&') { col++; continue; }
                return -1; // nothing useful follows
            }

            // Any other character — can't bridge this gap
            return -1;
        }
        return -1;
    }

    // Step 1: read first fragment
    const firstLine = document.lineAt(startLine).text;
    const firstFrag = readFragment(firstLine, startCol);
    if (!firstFrag) { return null; }

    appendFragment(startLine, firstLine, firstFrag);

    let scanLine = startLine;
    let scanText = firstLine;
    let scanCol  = firstFrag.nextCol;

    // Steps 2–4: scan for more fragments on the same or continuation lines
    while (true) {
        const nextQuoteCol = findNextQuote(scanText, scanCol);
        if (nextQuoteCol !== -1) {
            const frag = readFragment(scanText, nextQuoteCol);
            if (frag) {
                appendFragment(scanLine, scanText, frag);
                scanCol = frag.nextCol;
                continue;
            }
        }

        if (!lineEndsWithContinuation(scanText, scanCol)) { break; }

        // Advance to the next non-blank line, skipping over empty lines.
        // A blank line inside a `& _` continuation chain is allowed in VBScript
        // and should not break the SQL string group.
        scanLine++;
        while (scanLine < lineCount && document.lineAt(scanLine).text.trim() === '') {
            scanLine++;
        }
        if (scanLine >= lineCount) { break; }

        scanText = document.lineAt(scanLine).text;
        scanCol  = 0;
        while (scanCol < scanText.length && scanText[scanCol] <= ' ') { scanCol++; }
    }

    if (!isSql(stitched)) { return null; }
    return { segments, stitched, omLine: new Int32Array(omLineArr), omCol: new Int32Array(omColArr) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Emit SQL semantic tokens for a confirmed SQL string group.
// Five passes (claimed[] prevents overlaps):
//   1. Table names/aliases  2. alias.column refs  3. @variables
//   4. Numeric literals     5. SQL keywords/functions/types
// ─────────────────────────────────────────────────────────────────────────────
// Context-sensitive token type overrides for emitSqlTokensForGroup.
const DUAL_ROLE_JOIN  = new Set(['left','right']);

// Words that look like SQL keywords but are also very common column names.
// They should only be coloured as keywords when they appear as the first
// argument inside a datepart-aware function call:
//   DATEADD(hour, 1, col)  DATEDIFF(minute, start, end)  DATEPART(week, col) …
// Everywhere else — SELECT Hour FROM t, t.Day = 5 — they are column names
// and must not be coloured so the theme leaves them as plain identifiers.
const DATEPART_WORDS = new Set([
    'year','month','day',
    'hour','minute','second','millisecond','microsecond','nanosecond',
    'dayofweek','dayofyear','week','weekday','quarter',
]);
const DATEPART_FUNCTIONS = new Set([
    'dateadd','datediff','datediff_big','datepart','datename',
]);

// Returns true when the word at `wordStart` in `sql` is the first argument
// inside a DATEADD/DATEDIFF/DATEPART/DATENAME call, i.e.:
//   DATEADD  (  <word>  ,  …
// The check looks backward from wordStart to confirm the immediately preceding
// non-whitespace character is '(' and the token before that '(' is a datepart
// function name.
function isDatepartArgument(sql: string, wordStart: number): boolean {
    // Step back past leading whitespace to find the preceding character
    let i = wordStart - 1;
    while (i >= 0 && (sql[i] === ' ' || sql[i] === '\t' || sql[i] === '\n' || sql[i] === '\r')) {
        i--;
    }
    if (i < 0 || sql[i] !== '(') { return false; }
    // Step back past the '(' to find the function name
    i--;
    while (i >= 0 && (sql[i] === ' ' || sql[i] === '\t')) { i--; }
    if (i < 0) { return false; }
    // Read the word backwards
    let end = i + 1;
    while (i >= 0 && /[a-zA-Z0-9_]/.test(sql[i])) { i--; }
    const fnName = sql.slice(i + 1, end).toLowerCase();
    return DATEPART_FUNCTIONS.has(fnName);
}

export function emitSqlTokensForGroup(
    builder: vscode.SemanticTokensBuilder,
    group: SqlStringGroup
): void {
    const { stitched, omLine, omCol } = group;

    const claimed = new Uint8Array(stitched.length);

    function claim(start: number, len: number): void {
        claimed.fill(1, start, start + len);
    }
    function isClaimed(start: number, len: number): boolean {
        const found = claimed.indexOf(1, start);
        return found !== -1 && found < start + len;
    }

    function emit(stitchedStart: number, len: number, tokenType: number): void {
        if (stitchedStart >= omLine.length) { return; }
        builder.push(omLine[stitchedStart], omCol[stitchedStart], len, tokenType, 0);
    }

    // Pass 1: table names
    const tableRangeSet = findTableRanges(stitched);
    for (const key of tableRangeSet) {
        const colon = key.indexOf(':');
        const off   = parseInt(key.slice(0, colon), 10);
        const len   = parseInt(key.slice(colon + 1), 10);

        if (isClaimed(off, len)) { continue; }

        const tok = stitched.slice(off, off + len);
        if (tok.startsWith('[') && tok.endsWith(']')) {
            emit(off,           1,       T_SQL_BRACKET_PUNC);
            const innerLen = len - 2;
            if (innerLen > 0) { emit(off + 1, innerLen, T_SQL_BRACKET_CON); }
            emit(off + len - 1, 1,       T_SQL_BRACKET_PUNC);
        } else {
            emit(off, len, T_SQL_BRACKET_CON);
        }
        claim(off, len);
    }

    // Pass 2: alias.column dot references — handles both bare and [bracketed] column names.
    // Pattern A: alias.bare  e.g.  o.CustomerID
    // Pattern B: alias.[Col] e.g.  c.[CustomerID]
    const dotPattern         = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(\*|[a-zA-Z_][a-zA-Z0-9_]*)/g;
    const dotBracketPattern  = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.\[([^\]]*)\]/g;
    let m: RegExpExecArray | null;

    // Pattern B — alias.[BracketedColumn]
    while ((m = dotBracketPattern.exec(stitched)) !== null) {
        const tableStart   = m.index;
        const tableLen     = m[1].length;
        const bracketStart = tableStart + tableLen + 1; // position of '['
        const bracketLen   = m[2].length + 2;           // includes [ and ]

        if (!isClaimed(tableStart, tableLen)) {
            emit(tableStart, tableLen, T_SQL_BRACKET_CON);
            claim(tableStart, tableLen);
        }
        if (!isClaimed(bracketStart, bracketLen)) {
            emit(bracketStart, bracketLen, T_SQL_COLUMN);
            claim(bracketStart, bracketLen);
        }
    }

    // Pattern A — alias.bareColumn
    while ((m = dotPattern.exec(stitched)) !== null) {
        const tableStart  = m.index;
        const tableLen    = m[1].length;
        const columnStart = tableStart + tableLen + 1;
        const columnLen   = m[2].length;

        if (!isClaimed(tableStart, tableLen))  { emit(tableStart,  tableLen,  T_SQL_BRACKET_CON); claim(tableStart,  tableLen);  }
        if (!isClaimed(columnStart, columnLen)) { emit(columnStart, columnLen, T_SQL_COLUMN);       claim(columnStart, columnLen); }
    }

    // Pass 3: @variable parameters
    const atPattern = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((m = atPattern.exec(stitched)) !== null) {
        if (isClaimed(m.index, m[0].length)) { continue; }
        emit(m.index, m[0].length, T_SQL_VAR);
        claim(m.index, m[0].length);
    }

    // Pass 4: numeric literals
    const numPattern = /\b\d+(\.\d+)?([eE][+-]?\d+)?\b/g;
    while ((m = numPattern.exec(stitched)) !== null) {
        if (isClaimed(m.index, m[0].length)) { continue; }
        emit(m.index, m[0].length, T_SQL_NUMBER);
        claim(m.index, m[0].length);
    }

    // Pass 5: SQL keywords / functions / types.
    const wordPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    while ((m = wordPattern.exec(stitched)) !== null) {
        if (isClaimed(m.index, m[1].length)) { continue; }
        let tokenType = sqlWordTokenType(m[1]);
        if (tokenType !== undefined) {
            const wLower = m[1].toLowerCase();
            const after  = stitched.slice(m.index + m[1].length);

            if (DUAL_ROLE_JOIN.has(wLower)) {
                // LEFT/RIGHT have two SQL roles:
                //   LEFT(str, n)     → SQL string function → T_SQL_FUNC
                //   LEFT JOIN table  → JOIN keyword        → T_SQL_DML
                // If followed by ( it's a function call; if followed by JOIN it's a keyword.
                // Anything else (e.g. bare LEFT in a column alias) stays uncoloured.
                if (/^\s*\(/.test(after)) {
                    tokenType = T_SQL_FUNC;
                } else if (/^\s+join\b/i.test(after)) {
                    tokenType = T_SQL_DML;
                } else {
                    continue; // uncoloured — ambiguous
                }
            } else if (DATEPART_WORDS.has(wLower)) {
                // Date-part words have three possible roles:
                //   HOUR(start_time)        → ( follows → function colour
                //   DATEADD(hour, 1, col)   → first arg inside datepart fn → keyword colour
                //   SELECT Hour FROM t      → bare column name → no colour
                if (/^\s*\(/.test(after)) {
                    tokenType = T_SQL_FUNC;
                } else if (!isDatepartArgument(stitched, m.index)) {
                    continue; // bare column name — leave uncoloured
                } else {
                    tokenType = T_SQL_KEYWORD;
                }
            }

            emit(m.index, m[1].length, tokenType);
            claim(m.index, m[1].length);
        }
    }
}