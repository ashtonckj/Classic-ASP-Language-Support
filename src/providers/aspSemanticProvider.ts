import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import { isInsideAspBlock } from '../utils/documentHelper';

// ─────────────────────────────────────────────────────────────────────────────
// Semantic token legend — must match contributes.semanticTokenScopes in package.json
//
// Token types (index order matters):
//   0  function         → user-defined Function names
//   1  namespace        → user-defined Sub names
//   2  variable         → Dim'd variables and COM object variables
//   3  parameter        → function/sub parameters inside their own body
//   4  enumMember       → Const values
//
// SQL token types (indices 5–16):
//   5  sqlDml           → SELECT, INSERT, UPDATE, DELETE, FROM, WHERE, JOIN …
//   6  sqlDdl           → CREATE, DROP, ALTER, TABLE …
//   7  sqlLogical       → AND, OR, NOT, IN, IS, LIKE, BETWEEN, EXISTS …
//   8  sqlKeyword       → AS, SET, VALUES, CASE, WHEN, THEN, BEGIN, DECLARE …
//   9  sqlFunction      → COUNT, SUM, AVG, CONVERT, GETDATE, ISNULL …
//  10  sqlType          → VARCHAR, INT, DATETIME, BIT …
//  11  sqlVariable      → @paramName
//  12  sqlNumber        → numeric literals  1, 42, 3.14 …
//  13  sqlBracketPunct  → the [ and ] characters
//  14  sqlBracketContent → text inside [brackets] AND bare-word table names/aliases
//  15  sqlTable         → left-hand side of table.column dot refs / bare-word table names
//  16  sqlColumn        → right-hand side of alias.column  e.g. "RowID" in u.RowID
//
// Token modifiers:
//   0  declaration → where the symbol is defined/declared
//   1  readonly    → used on constants
// ─────────────────────────────────────────────────────────────────────────────
export const ASP_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
    [
        'function', 'namespace', 'variable', 'parameter', 'enumMember',
        'sqlDml', 'sqlDdl', 'sqlLogical', 'sqlKeyword', 'sqlFunction', 'sqlType', 'sqlVariable',
        'sqlNumber', 'sqlBracketPunct', 'sqlBracketContent', 'sqlTable', 'sqlColumn',
    ],
    ['declaration', 'readonly']
);

// Token type indices
const T_FUNCTION         = 0;
const T_NAMESPACE        = 1;
const T_VARIABLE         = 2;
const T_PARAMETER        = 3;
const T_CONSTANT         = 4;
const T_SQL_DML          = 5;
const T_SQL_DDL          = 6;
const T_SQL_LOGICAL      = 7;
const T_SQL_KEYWORD      = 8;
const T_SQL_FUNC         = 9;
const T_SQL_TYPE         = 10;
const T_SQL_VAR          = 11;
const T_SQL_NUMBER       = 12;
const T_SQL_BRACKET_PUNC = 13;
const T_SQL_BRACKET_CON  = 14;
// T_SQL_TABLE = 15 (unused directly; coloured via T_SQL_BRACKET_CON)
const T_SQL_COLUMN       = 16;

// Token modifier bit masks
const M_DECLARATION = 1;
const M_READONLY    = 2;

// ─────────────────────────────────────────────────────────────────────────────
// SQL detection — requires BOTH a DML/DDL verb AND a clause keyword.
// Guard: FROM followed by an English article (the/a/an/this/that/my/your etc.)
// is plain English, not SQL — e.g. "Select an option from the list".
// ─────────────────────────────────────────────────────────────────────────────
const SQL_VERBS   = /\b(SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE|CREATE|DROP|ALTER|TRUNCATE|MERGE)\b/i;
const SQL_CLAUSES = /\b(FROM|INTO|TABLE|SET|VALUES|WHERE|JOIN|UNION|HAVING|GROUP\s+BY|ORDER\s+BY|RETURNING|DECLARE|BEGIN\s+TRAN|COMMIT|ROLLBACK|USING|WHEN\s+MATCHED|WHEN\s+NOT\s+MATCHED)\b/i;
const ENGLISH_ARTICLES = /^(the|a|an|this|that|these|those|my|your|our|their|its|her|his)$/i;

function isSql(text: string): boolean {
    if (!SQL_VERBS.test(text) || !SQL_CLAUSES.test(text)) { return false; }
    const fromMatch = text.match(/\bFROM\s+(\w+)/i);
    if (fromMatch && ENGLISH_ARTICLES.test(fromMatch[1])) {
        const withoutFrom = text.replace(/\bFROM\s+\w+/gi, '');
        if (!SQL_CLAUSES.test(withoutFrom)) { return false; }
    }
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
const ALL_SQL_KEYWORDS = new Set([
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
const RE_WORD  = /[a-zA-Z_#][a-zA-Z0-9_#]*/y;
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
            addRanges(collectTableChain(sig, i + 1));
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
interface SqlStringSegment {
    lineIndex: number;
    lineText:  string;
    colStart:  number;
    colEnd:    number;
}
interface SqlStringGroup {
    segments: SqlStringSegment[];
    stitched: string;
    offsetMap: Array<{lineIndex: number; col: number}>;
}

function extractSqlGroup(
    document: vscode.TextDocument,
    startLine: number,
    startCol: number
): SqlStringGroup | null {

    const lineCount = document.lineCount;
    const segments: SqlStringSegment[] = [];
    let   stitched  = '';
    const offsetMap: Array<{lineIndex: number; col: number}> = [];

    // Read one "..." fragment at lineText[col]. Handles "" escaped quotes.
    // colOffsets maps each content character back to its original column.
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

    // Append a fragment to stitched + offsetMap.
    function appendFragment(lineIndex: number, lineText: string, frag: {
        content: string; colStart: number; colEnd: number; colOffsets: number[];
    }): void {
        if (stitched.length > 0) {
            offsetMap.push({ lineIndex, col: frag.colStart });
            stitched += ' ';
        }
        for (const c of frag.colOffsets) {
            offsetMap.push({ lineIndex, col: c });
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
    function findNextQuote(lineText: string, col: number): number {
        while (col < lineText.length && lineText[col] === ' ') { col++; }
        if (col < lineText.length && lineText[col] === '"') { return col; }
        if (col >= lineText.length || lineText[col] !== '&') { return -1; }
        col++;
        let depth = 0;
        while (col < lineText.length) {
            const ch = lineText[col];
            if (ch === '(') { depth++; col++; continue; }
            if (ch === ')') { depth--; col++; continue; }
            if (depth === 0 && ch === '"') { return col; }
            if (depth === 0 && ch === '&') {
                col++;
                while (col < lineText.length && lineText[col] === ' ') { col++; }
                if (col < lineText.length && lineText[col] === '"') { return col; }
                continue;
            }
            col++;
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

        scanLine++;
        if (scanLine >= lineCount) { break; }

        scanText = document.lineAt(scanLine).text;
        scanCol  = 0;
        while (scanCol < scanText.length && scanText[scanCol] === ' ') { scanCol++; }
    }

    if (!isSql(stitched)) { return null; }
    return { segments, stitched, offsetMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// Emit SQL semantic tokens for a confirmed SQL string group.
// Five passes (claimed[] prevents overlaps):
//   1. Table names/aliases  2. alias.column refs  3. @variables
//   4. Numeric literals     5. SQL keywords/functions/types
// ─────────────────────────────────────────────────────────────────────────────
function emitSqlTokensForGroup(
    builder: vscode.SemanticTokensBuilder,
    group: SqlStringGroup
): void {
    const { stitched, offsetMap } = group;

    const claimed = new Uint8Array(stitched.length);

    function claim(start: number, len: number): void {
        claimed.fill(1, start, start + len);
    }
    function isClaimed(start: number, len: number): boolean {
        for (let i = start; i < start + len; i++) {
            if (claimed[i]) { return true; }
        }
        return false;
    }

    function emit(stitchedStart: number, len: number, tokenType: number): void {
        if (stitchedStart >= offsetMap.length) { return; }
        const { lineIndex, col } = offsetMap[stitchedStart];
        builder.push(lineIndex, col, len, tokenType, 0);
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

    // Pass 2: alias.column dot references
    const dotPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(\*|[a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
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
    // Context-sensitive overrides:
    //   LEFT/RIGHT  → T_SQL_DML  when followed by JOIN  (otherwise T_SQL_FUNC)
    //   YEAR/MONTH/DAY → T_SQL_FUNC when followed by (  (otherwise T_SQL_KEYWORD like BY)
    const DUAL_ROLE_JOIN  = new Set(['left','right']);
    const DUAL_ROLE_DATES = new Set(['year','month','day']);
    const wordPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    while ((m = wordPattern.exec(stitched)) !== null) {
        if (isClaimed(m.index, m[1].length)) { continue; }
        let tokenType = sqlWordTokenType(m[1]);
        if (tokenType !== undefined) {
            const wLower = m[1].toLowerCase();
            const after  = stitched.slice(m.index + m[1].length);
            if (DUAL_ROLE_JOIN.has(wLower)) {
                // LEFT/RIGHT before JOIN → DML colour (same as JOIN)
                if (/^\s+join\b/i.test(after)) { tokenType = T_SQL_DML; }
            } else if (DUAL_ROLE_DATES.has(wLower)) {
                // YEAR/MONTH/DAY before ( → function colour; bare → keyword colour
                if (/^\s*\(/.test(after)) { tokenType = T_SQL_FUNC; }
                else                        { tokenType = T_SQL_KEYWORD; }
            }
            emit(m.index, m[1].length, tokenType);
            claim(m.index, m[1].length);
        }
    }
}

export class AspSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {

    private readonly _diagnostics: vscode.DiagnosticCollection;

    constructor() {
        this._diagnostics = vscode.languages.createDiagnosticCollection('asp-sql-vars');
    }

    dispose(): void {
        this._diagnostics.dispose();
    }

    provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SemanticTokens> {

        const builder    = new vscode.SemanticTokensBuilder(ASP_SEMANTIC_LEGEND);
        const text       = document.getText();
        const allSymbols = collectAllSymbols(document);

        // Build fast lookup sets/maps from collected symbols
        const funcMap = new Map<string, 'function' | 'Sub'>();
        for (const fn of allSymbols.functions) {
            funcMap.set(fn.name.toLowerCase(), fn.kind === 'Function' ? 'function' : 'Sub');
        }
        const varSet    = new Set<string>(allSymbols.variables.map(v => v.name.toLowerCase()));
        const comVarSet = new Set<string>(allSymbols.comVariables.map(cv => cv.name.toLowerCase()));
        const constSet  = new Set<string>(allSymbols.constants.map(c => c.name.toLowerCase()));

        // Parameter scoping: lineNumber → Set<paramName>
        const lineCount = document.lineCount;
        const lineParamSets: Map<number, Set<string>> = new Map();
        for (const fn of allSymbols.functions) {
            if (fn.paramNames.length === 0)          { continue; }
            if (fn.filePath !== document.uri.fsPath)  { continue; }
            const start = fn.line;
            const end   = fn.endLine !== -1 ? fn.endLine : lineCount - 1;
            for (let l = start; l <= end; l++) {
                if (!lineParamSets.has(l)) { lineParamSets.set(l, new Set()); }
                for (const p of fn.paramNames) { lineParamSets.get(l)!.add(p.toLowerCase()); }
            }
        }

        // ── Pass A: SQL variable discovery ───────────────────────────────────
        // isSqlOrFragment: like isSql() but also accepts bare EXEC calls.
        function isSqlOrFragment(t: string): boolean {
            return isSql(t) || /^\s*EXEC(?:UTE)?\s+/i.test(t);
        }

        // isSqlClauseFragment: accepts strings that are clearly SQL fragments
        // even without a leading verb — e.g. a WHERE/AND/OR/ORDER BY block that
        // a function returns to be appended onto a larger query.
        // Rules: must start with a recognised clause word (after optional whitespace)
        // AND must not look like plain English (no verb means we rely on the
        // clause word itself being the very first meaningful token).
        const SQL_FRAGMENT_STARTERS = /^\s*(WHERE|AND\b|OR\b|ORDER\s+BY|GROUP\s+BY|HAVING|ON\b|SET\b|JOIN\b|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|UNION(\s+ALL)?|WHEN\s+(MATCHED|NOT))/i;
        function isSqlClauseFragment(t: string): boolean {
            return SQL_FRAGMENT_STARTERS.test(t);
        }

        interface VarAssignment {
            isSelfAppend:  boolean;
            stitchedValue: string;
        }
        const assignmentMap    = new Map<string, VarAssignment[]>();
        const assignPattern    = /^\s*([a-zA-Z_]\w*)\s*=\s*(.+)$/;
        const processedAssignLines = new Set<number>();

        for (let li = 0; li < lineCount; li++) {
            if (processedAssignLines.has(li)) { continue; }

            const lineText   = document.lineAt(li).text;
            const lineOffset = document.offsetAt(new vscode.Position(li, 0));
            const midOffset  = lineOffset + Math.floor(lineText.length / 2);
            if (!isInsideAspBlock(text, midOffset)) { continue; }

            let stripped = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
            const cpIdx = stripped.indexOf("'");
            if (cpIdx !== -1) { stripped = stripped.substring(0, cpIdx); }

            const am = assignPattern.exec(stripped);
            if (!am) { continue; }

            const varName = am[1].toLowerCase();
            const rhs     = am[2].trim();

            // Cache escaped varName for self-append check
            const escapedVar = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const isSelfAppend = new RegExp('^\\b' + escapedVar + '\\b\\s*&', 'i').test(rhs);

            const quoteCol = lineText.indexOf('"', lineText.indexOf(am[1]));
            let stitchedValue = '';

            if (quoteCol !== -1) {
                const group = extractSqlGroup(document, li, quoteCol);
                if (group !== null) {
                    stitchedValue = group.stitched;
                    for (const seg of group.segments) { processedAssignLines.add(seg.lineIndex); }
                } else {
                    const strPat = /"((?:[^"]|"")*)"/g;
                    let sm: RegExpExecArray | null;
                    const lits: string[] = [];
                    while ((sm = strPat.exec(lineText)) !== null) {
                        lits.push(sm[1].replace(/""/g, '"'));
                    }
                    stitchedValue = lits.join(' ');
                }
            }

            if (!stitchedValue) { continue; }

            if (!assignmentMap.has(varName)) { assignmentMap.set(varName, []); }
            assignmentMap.get(varName)!.push({ isSelfAppend, stitchedValue });
        }

        // Sub-pass 1: direct SQL assignments
        const sqlVars = new Set<string>();
        for (const [varName, assignments] of assignmentMap) {
            for (const a of assignments) {
                if (!a.isSelfAppend && (isSqlOrFragment(a.stitchedValue) || isSqlClauseFragment(a.stitchedValue))) {
                    sqlVars.add(varName);
                    break;
                }
            }
        }

        // Sub-pass 2: self-append propagation — repeat until stable
        let changed = true;
        while (changed) {
            changed = false;
            for (const [varName, assignments] of assignmentMap) {
                if (sqlVars.has(varName)) { continue; }
                const selfAssigns    = assignments.filter(a =>  a.isSelfAppend);
                if (selfAssigns.length === 0) { continue; }
                const nonSelfAssigns = assignments.filter(a => !a.isSelfAppend);
                if (nonSelfAssigns.length > 0 && !nonSelfAssigns.every(a => isSql(a.stitchedValue))) { continue; }
                sqlVars.add(varName);
                changed = true;
            }
        }

        // ── Build line-text cache (needed by all subsequent passes) ──────────
        const lineTextCache: string[] = new Array(lineCount);
        for (let li = 0; li < lineCount; li++) {
            lineTextCache[li] = document.lineAt(li).text;
        }

        // ── Sub-pass 3: SQL function return analysis ──────────────────────────
        // For every Function defined in this document, scan its body for the
        // VBScript return-value pattern:  FunctionName = <expr>
        // Stitch any string literals found on those lines the same way
        // assignmentMap does, then test with isSqlOrFragment.
        //
        // Result sets:
        //   sqlFuncs      — functions confirmed to return SQL
        //   nonStrFuncs   — functions that never assign a string return value
        //                   (return value appears to be non-string or absent)
        //
        // Functions whose return value cannot be determined (e.g. they call
        // other functions we haven't seen) are left out of both sets so we
        // don't produce false warnings for them.
        // ─────────────────────────────────────────────────────────────────────
        const sqlFuncs    = new Set<string>(); // funcName.toLowerCase()
        const nonStrFuncs = new Set<string>(); // funcName.toLowerCase()

        for (const fn of allSymbols.functions) {
            if (fn.kind !== 'Function')            { continue; } // Subs can't return values
            if (fn.filePath !== document.uri.fsPath) { continue; }
            if (fn.endLine === -1)                 { continue; }

            const fnKey         = fn.name.toLowerCase();
            // Pattern: <FunctionName>\s*=\s*<rhs>  (not preceded by another word char,
            // to avoid matching inside longer names)
            const escapedFnName = fn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const returnPattern = new RegExp(
                '^\\s*' + escapedFnName + '\\s*=\\s*(.+)$', 'i'
            );

            let foundStringReturn = false;
            let isSqlReturn       = false;

            for (let li = fn.line; li <= fn.endLine; li++) {
                const lineText = lineTextCache[li];

                // Strip string literals and comments for structural matching
                let stripped = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                const cpIdx  = stripped.indexOf("'");
                if (cpIdx !== -1) { stripped = stripped.substring(0, cpIdx); }

                const rm = returnPattern.exec(stripped);
                if (!rm) { continue; }

                // Found a return assignment — check if it contains a string literal
                const quoteCol = lineText.indexOf('"');
                if (quoteCol === -1) {
                    // RHS has no string literal on this line — could be a variable
                    // or a non-string expression.  We don't flag it either way;
                    // we just note there was *some* return assignment.
                    foundStringReturn = true; // pessimistically treat as string-capable
                    continue;
                }

                foundStringReturn = true;

                // Try to stitch multi-line string the same way assignmentMap does
                const group = extractSqlGroup(document, li, quoteCol);
                let stitched = '';
                if (group !== null) {
                    stitched = group.stitched;
                } else {
                    const strPat = /"((?:[^"]|"")*)"/g;
                    let sm: RegExpExecArray | null;
                    const lits: string[] = [];
                    while ((sm = strPat.exec(lineText)) !== null) {
                        lits.push(sm[1].replace(/""/g, '"'));
                    }
                    stitched = lits.join(' ');
                }

                if (stitched && (isSqlOrFragment(stitched) || isSqlClauseFragment(stitched))) {
                    isSqlReturn = true;
                    break; // one confirmed SQL return is enough
                }
            }

            if (isSqlReturn) {
                sqlFuncs.add(fnKey);
            } else if (!foundStringReturn) {
                // Function body has no string return at all — treat as non-string
                nonStrFuncs.add(fnKey);
            }
            // If foundStringReturn && !isSqlReturn: the function returns a string
            // but it didn't look like SQL — we leave it out of both sets so we
            // only warn when it's used inside a SQL concatenation (see below).
        }

        // ── SQL variable reuse diagnostics ────────────────────────────────────
        // Warn when a known SQL variable is assigned a plain non-SQL string.

        const sqlDiagnostics: vscode.Diagnostic[] = [];
        const assignLinePattern = /^\s*([a-zA-Z_]\w*)\s*=\s*(.+)$/;

        for (const [varName3, assignments] of assignmentMap) {
            if (!sqlVars.has(varName3)) { continue; }

            for (const a of assignments) {
                if (a.isSelfAppend || isSqlOrFragment(a.stitchedValue) || isSqlClauseFragment(a.stitchedValue)) { continue; }

                // Find the matching line for this suspicious assignment
                const escapedV3 = varName3.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const selfRefRe  = new RegExp('^\\b' + escapedV3 + '\\b', 'i');
                const varNameRe  = new RegExp('\\b' + escapedV3 + '\\b', 'i');

                for (let li = 0; li < lineCount; li++) {
                    const lineText   = lineTextCache[li];
                    const lineOffset = document.offsetAt(new vscode.Position(li, 0));
                    const midOffset  = lineOffset + Math.floor(lineText.length / 2);
                    if (!isInsideAspBlock(text, midOffset)) { continue; }

                    let stripped3 = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                    const cp3 = stripped3.indexOf("'");
                    if (cp3 !== -1) { stripped3 = stripped3.substring(0, cp3); }

                    const am3 = assignLinePattern.exec(stripped3);
                    if (!am3 || am3[1].toLowerCase() !== varName3) { continue; }
                    if (selfRefRe.test(am3[2].trim())) { continue; }

                    const sp3 = /"((?:[^"]|"")*)"/g;
                    let sm3: RegExpExecArray | null;
                    const lits3: string[] = [];
                    while ((sm3 = sp3.exec(lineText)) !== null) {
                        lits3.push(sm3[1].replace(/""/g, '"'));
                    }
                    if (lits3.length === 0 || lits3.join(' ') !== a.stitchedValue) { continue; }

                    const varCol = lineText.search(varNameRe);
                    if (varCol === -1) { continue; }

                    const range = new vscode.Range(
                        new vscode.Position(li, varCol),
                        new vscode.Position(li, varCol + varName3.length)
                    );
                    const diag = new vscode.Diagnostic(
                        range,
                        `'${am3[1]}' is already marked as a SQL variable. Highlighting may be incorrect.`,
                        vscode.DiagnosticSeverity.Warning
                    );
                    diag.source = 'ASP SQL';
                    sqlDiagnostics.push(diag);
                    break;
                }
            }
        }

        // ── Pass B: warn on non-SQL variables/functions concatenated into SQL ─
        //
        // For every line that is a SQL variable assignment or self-append,
        // scan the *non-string* parts of the line for:
        //   (a) bare VBScript variable references that are NOT in sqlVars
        //   (b) function calls whose function is NOT in sqlFuncs
        //
        // We skip:
        //   • VBScript keywords
        //   • known SQL keywords (they appear as bare words in concat gaps)
        //   • variables/functions we simply have no information about
        //     (i.e. not declared anywhere in the symbol table) — too noisy
        //   • functions in nonStrFuncs get a stronger "not a string" warning
        // ─────────────────────────────────────────────────────────────────────

        // Build set of all known declared symbol names for filtering noise
        const knownSymbols = new Set<string>([
            ...allSymbols.variables.map(v => v.name.toLowerCase()),
            ...allSymbols.comVariables.map(cv => cv.name.toLowerCase()),
            ...allSymbols.constants.map(c => c.name.toLowerCase()),
            ...allSymbols.functions.map(f => f.name.toLowerCase()),
        ]);

        // Pattern to find VBScript identifiers outside string literals
        const identPattern = /\b([a-zA-Z_]\w*)\b/g;

        // Pre-build the set of sql variable names lowercased for fast lookup
        const sqlVarsLower = new Set([...sqlVars].map(v => v.toLowerCase()));

        for (let li = 0; li < lineCount; li++) {
            const lineText   = lineTextCache[li];
            const lineOffset = document.offsetAt(new vscode.Position(li, 0));
            const midOffset  = lineOffset + Math.floor(lineText.length / 2);
            if (!isInsideAspBlock(text, midOffset)) { continue; }

            // Strip string literals — replace with a sentinel char (§) so we can
            // distinguish "there was a string here" from pure whitespace gaps.
            // This lets us detect value-interpolation:  "..." & someVar & "..."
            const strippedForIdents = lineText.replace(/"(?:[^"]|"")*"/g, m => '§' + ' '.repeat(m.length - 1));
            // Strip VBScript comment
            const commentIdx = strippedForIdents.indexOf("'");
            const activeText = commentIdx !== -1
                ? strippedForIdents.substring(0, commentIdx)
                : strippedForIdents;

            // Is this line a SQL variable assignment or self-append?
            const assignMatch = assignLinePattern.exec(activeText);
            if (!assignMatch) { continue; }
            const lhsVar = assignMatch[1].toLowerCase();
            if (!sqlVarsLower.has(lhsVar)) { continue; }

            // We're on a line that writes into a confirmed SQL variable.
            const rhsStart = lineText.indexOf(assignMatch[1]) + assignMatch[1].length;
            const rhsText  = activeText.slice(rhsStart);
            const rhsOffset = rhsStart;

            // Helper: given a position in rhsText, scan backwards (skipping spaces)
            // to find if there's a string sentinel (§) before the preceding &
            // and forwards to find if there's a string sentinel after the following &.
            // If BOTH sides are flanked by string literals → value interpolation → skip.
            function isValueInterpolation(startInRhs: number, endInRhs: number): boolean {
                // Look left: skip whitespace, expect &, skip whitespace, expect §
                let l = startInRhs - 1;
                while (l >= 0 && (rhsText[l] === ' ' || rhsText[l] === '\t')) { l--; }
                if (l < 0 || rhsText[l] !== '&') { return false; }
                l--;
                while (l >= 0 && (rhsText[l] === ' ' || rhsText[l] === '\t')) { l--; }
                const leftIsStr = l >= 0 && rhsText[l] === '§';

                // Look right: skip the call's closing paren if any, then skip whitespace, expect &, skip whitespace, expect §
                let r = endInRhs;
                // skip balanced parens for function calls
                if (r < rhsText.length && rhsText[r] === '(') {
                    let depth = 1; r++;
                    while (r < rhsText.length && depth > 0) {
                        if (rhsText[r] === '(') { depth++; }
                        else if (rhsText[r] === ')') { depth--; }
                        r++;
                    }
                }
                while (r < rhsText.length && (rhsText[r] === ' ' || rhsText[r] === '\t')) { r++; }
                if (r >= rhsText.length || rhsText[r] !== '&') { return false; }
                r++;
                while (r < rhsText.length && (rhsText[r] === ' ' || rhsText[r] === '\t')) { r++; }
                const rightIsStr = r < rhsText.length && rhsText[r] === '§';

                return leftIsStr && rightIsStr;
            }

            identPattern.lastIndex = 0;
            let m2: RegExpExecArray | null;
            while ((m2 = identPattern.exec(rhsText)) !== null) {
                const word    = m2[1];
                const wordKey = word.toLowerCase();
                const col     = rhsOffset + m2.index;

                // Skip: the LHS variable itself (self-append pattern)
                if (wordKey === lhsVar) { continue; }

                // Skip: VBScript language keywords
                if (VBSCRIPT_KEYWORDS.has(wordKey)) { continue; }

                // Skip: SQL keywords that appear as bare words in concat gaps
                if (ALL_SQL_KEYWORDS.has(wordKey)) { continue; }

                // Skip: symbols we have no knowledge of — avoids noisy warnings
                if (!knownSymbols.has(wordKey)) { continue; }

                // Check if next non-space char is '(' (function call)
                const afterWord = rhsText.slice(m2.index + word.length).trimStart();
                const isCall    = afterWord.startsWith('(');

                // Skip: value interpolation — identifier flanked by string literals
                // on both sides via & operators, e.g.  "sql" & Trim(x) & "sql"
                // These are injecting VALUES into SQL, not SQL structure.
                if (isValueInterpolation(m2.index, m2.index + word.length)) { continue; }

                if (isCall) {
                    // ── Function call in SQL context ──────────────────────────
                    if (sqlFuncs.has(wordKey)) { continue; } // confirmed SQL — fine

                    const range = new vscode.Range(
                        new vscode.Position(li, col),
                        new vscode.Position(li, col + word.length)
                    );

                    if (nonStrFuncs.has(wordKey)) {
                        sqlDiagnostics.push(Object.assign(
                            new vscode.Diagnostic(
                                range,
                                `'${word}()' does not appear to return a string. ` +
                                `Concatenating it into a SQL variable may produce unexpected results.`,
                                vscode.DiagnosticSeverity.Warning
                            ),
                            { source: 'ASP SQL' }
                        ));
                    } else {
                        sqlDiagnostics.push(Object.assign(
                            new vscode.Diagnostic(
                                range,
                                `'${word}()' is concatenated into SQL variable '${assignMatch[1]}' ` +
                                `but its return value could not be confirmed as a SQL string. ` +
                                `Verify that it returns valid SQL or a safe SQL fragment.`,
                                vscode.DiagnosticSeverity.Warning
                            ),
                            { source: 'ASP SQL' }
                        ));
                    }
                } else {
                    // ── Variable reference in SQL context ─────────────────────
                    if (sqlVarsLower.has(wordKey)) { continue; } // confirmed SQL var — fine

                    const range = new vscode.Range(
                        new vscode.Position(li, col),
                        new vscode.Position(li, col + word.length)
                    );
                    sqlDiagnostics.push(Object.assign(
                        new vscode.Diagnostic(
                            range,
                            `'${word}' is concatenated into SQL variable '${assignMatch[1]}' ` +
                            `but has not been confirmed as a SQL variable or fragment. ` +
                            `If this is intentional (e.g. a WHERE clause fragment), ` +
                            `initialise '${word}' with a SQL keyword like WHERE or AND.`,
                            vscode.DiagnosticSeverity.Warning
                        ),
                        { source: 'ASP SQL' }
                    ));
                }
            }
        }

        // Re-commit diagnostics now that Pass B has added to sqlDiagnostics
        this._diagnostics.set(document.uri, sqlDiagnostics);

        // ── SQL string pre-pass ───────────────────────────────────────────────
        // Colour confirmed SQL strings and fragments appended to SQL variables.
        const sqlStringLines    = new Map<number, Array<[number, number]>>();
        const processedSqlLines = new Set<number>();

        // Colour a single string literal as SQL (for known SQL variable appends).
        function emitFragmentAsSql(
            li: number, lineText: string, colStart: number, colEnd: number
        ): void {
            const content = lineText.substring(colStart, colEnd);
            const offsetMap = [];
            for (let c = colStart; c < colEnd; c++) {
                offsetMap.push({ lineIndex: li, col: c });
            }
            const group: SqlStringGroup = {
                segments:  [{ lineIndex: li, lineText, colStart, colEnd }],
                stitched:  content,
                offsetMap,
            };
            emitSqlTokensForGroup(builder, group);
            if (!sqlStringLines.has(li)) { sqlStringLines.set(li, []); }
            sqlStringLines.get(li)!.push([colStart, colEnd]);
        }

        // Pre-compile per-sqlVar regexes to avoid rebuilding inside the line loop.
        // Also include confirmed SQL-returning functions: inside their body, lines
        // like  FunctionName = "WITH ..."  should be coloured exactly like SQL var
        // assignments.  Adding the function name to sqlVarPatterns achieves this
        // because the pre-pass checks whether the line starts with a known name
        // followed by = or &.
        const sqlVarPatterns: Array<RegExp> = [];
        for (const sqlVar of sqlVars) {
            const esc = sqlVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            sqlVarPatterns.push(new RegExp('^\\s*' + esc + '\\s*(?:=|&)', 'i'));
        }
        for (const fnName of sqlFuncs) {
            const esc = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            sqlVarPatterns.push(new RegExp('^\\s*' + esc + '\\s*(?:=|&)', 'i'));
        }

        for (let li = 0; li < lineCount; li++) {
            if (processedSqlLines.has(li)) { continue; }

            const lineText   = lineTextCache[li];
            const lineOffset = document.offsetAt(new vscode.Position(li, 0));
            const midOffset  = lineOffset + Math.floor(lineText.length / 2);
            if (!isInsideAspBlock(text, midOffset)) { continue; }

            let lineIsSqlAppend = false;
            if (sqlVarPatterns.length > 0) {
                let stripped2 = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                const cp2 = stripped2.indexOf("'");
                if (cp2 !== -1) { stripped2 = stripped2.substring(0, cp2); }
                for (const re of sqlVarPatterns) {
                    if (re.test(stripped2)) { lineIsSqlAppend = true; break; }
                }
                // If this line itself didn't match, walk backwards through & _
                // continuation lines to find if the assignment head matches.
                // E.g.:  GetActiveFilter = _        ← assignment head (no quotes)
                //            "WHERE ..."  & _       ← this line, needs colouring
                if (!lineIsSqlAppend) {
                    let checkLi = li - 1;
                    while (checkLi >= 0) {
                        const prevText = lineTextCache[checkLi];
                        // The previous line must end with & _ or = _ (continuation)
                        const trimmed = prevText.trimEnd();
                        if (!trimmed.endsWith('_')) { break; }
                        // Check whether it ends with  & _  or  = _
                        const beforeUnderscore = trimmed.slice(0, -1).trimEnd();
                        if (!beforeUnderscore.endsWith('&') && !beforeUnderscore.endsWith('=')) { break; }

                        let prevStripped = prevText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                        const prevCp = prevStripped.indexOf("'");
                        if (prevCp !== -1) { prevStripped = prevStripped.substring(0, prevCp); }
                        for (const re of sqlVarPatterns) {
                            if (re.test(prevStripped)) { lineIsSqlAppend = true; break; }
                        }
                        if (lineIsSqlAppend) { break; }
                        checkLi--;
                    }
                }
            }

            let col = 0;
            while (col < lineText.length) {
                if (lineText[col] !== '"') { col++; continue; }

                const group = extractSqlGroup(document, li, col);

                if (group !== null) {
                    emitSqlTokensForGroup(builder, group);
                    for (const seg of group.segments) {
                        processedSqlLines.add(seg.lineIndex);
                        if (!sqlStringLines.has(seg.lineIndex)) {
                            sqlStringLines.set(seg.lineIndex, []);
                        }
                        sqlStringLines.get(seg.lineIndex)!.push([seg.colStart, seg.colEnd]);
                    }
                    col = group.segments[0].colEnd + 1;
                } else if (lineIsSqlAppend) {
                    col++;
                    const fragStart = col;
                    while (col < lineText.length) {
                        if (lineText[col] === '"') {
                            if (col + 1 < lineText.length && lineText[col + 1] === '"') { col += 2; }
                            else { break; }
                        } else { col++; }
                    }
                    if (col < lineText.length) {
                        emitFragmentAsSql(li, lineText, fragStart, col);
                        col++;
                    }
                } else {
                    // Skip past non-SQL string
                    col++;
                    while (col < lineText.length) {
                        if (lineText[col] === '"') {
                            if (col + 1 < lineText.length && lineText[col + 1] === '"') { col += 2; }
                            else { col++; break; }
                        } else { col++; }
                    }
                }
            }
        }

        // ── VBScript identifier pass ──────────────────────────────────────────
        for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
            const line       = lineTextCache[lineIndex];
            const lineOffset = document.offsetAt(new vscode.Position(lineIndex, 0));
            const midOffset  = lineOffset + Math.floor(line.length / 2);
            if (!isInsideAspBlock(text, midOffset)) { continue; }

            const trimmed = line.trimStart();
            if (trimmed.startsWith("'") || /^rem\s/i.test(trimmed)) { continue; }

            let strippedLine = line.replace(/"[^"]*"/g, (m: string) => ' '.repeat(m.length));
            const commentIdx = strippedLine.indexOf("'");
            if (commentIdx !== -1) { strippedLine = strippedLine.substring(0, commentIdx); }

            const activeParams = lineParamSets.get(lineIndex);
            const sqlRanges    = sqlStringLines.get(lineIndex);

            const isFuncDeclaration = /^\s*(?:Public\s+|Private\s+)?(?:Function|Sub)\s+/i.test(line);
            const isDimLine         = /^\s*(?:Dim|ReDim|Public|Private)\s+/i.test(line);
            const isConstLine       = /^\s*(?:Public\s+|Private\s+)?Const\s+/i.test(line);
            const isSetLine         = /^\s*Set\s+\w+\s*=/i.test(line);

            const wordPattern = /\b([a-zA-Z_]\w*)\b/g;
            let match: RegExpExecArray | null;

            while ((match = wordPattern.exec(strippedLine)) !== null) {
                const word    = match[1];
                const wordKey = word.toLowerCase();
                const col     = match.index;

                if (sqlRanges?.some(([s, e]) => col >= s && col < e)) { continue; }
                if (VBSCRIPT_KEYWORDS.has(wordKey)) { continue; }

                if (funcMap.has(wordKey)) {
                    const kind         = funcMap.get(wordKey)!;
                    const tokenType    = kind === 'function' ? T_FUNCTION : T_NAMESPACE;
                    const modifierMask = isFuncDeclaration && word === line.match(/(?:Function|Sub)\s+(\w+)/i)?.[1]
                        ? M_DECLARATION : 0;
                    builder.push(lineIndex, col, word.length, tokenType, modifierMask);
                    continue;
                }
                if (activeParams?.has(wordKey)) {
                    builder.push(lineIndex, col, word.length, T_PARAMETER, isFuncDeclaration ? M_DECLARATION : 0);
                    continue;
                }
                if (constSet.has(wordKey)) {
                    builder.push(lineIndex, col, word.length, T_CONSTANT, isConstLine ? M_DECLARATION | M_READONLY : M_READONLY);
                    continue;
                }
                if (comVarSet.has(wordKey)) {
                    builder.push(lineIndex, col, word.length, T_VARIABLE, isSetLine ? M_DECLARATION : 0);
                    continue;
                }
                if (varSet.has(wordKey)) {
                    builder.push(lineIndex, col, word.length, T_VARIABLE, isDimLine ? M_DECLARATION : 0);
                    continue;
                }
            }
        }

        return builder.build();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// VBScript keywords — never coloured as variables/functions
// ─────────────────────────────────────────────────────────────────────────────
const VBSCRIPT_KEYWORDS = new Set([
    'dim','redim','set','let','get','const','call','new',
    'if','then','else','elseif','end','select','case',
    'for','each','in','to','step','next',
    'while','wend','do','loop','until',
    'function','sub','class','property',
    'private','public','default',
    'and','or','not','xor','eqv','imp','is','mod',
    'true','false','null','nothing','empty',
    'with','exit','return','goto','on','error','resume',
    'option','explicit','randomize',
    'response','request','server','session','application',
]);