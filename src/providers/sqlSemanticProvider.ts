import * as vscode from 'vscode';

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
export const T_FUNCTION         = 0;
export const T_NAMESPACE        = 1;
export const T_VARIABLE         = 2;
export const T_PARAMETER        = 3;
export const T_CONSTANT         = 4;
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
export const M_DECLARATION = 1;
export const M_READONLY    = 2;

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
    offsetMap: Array<{lineIndex: number; col: number}>;
}

export function extractSqlGroup(
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
// Context-sensitive token type overrides for emitSqlTokensForGroup.
const DUAL_ROLE_JOIN  = new Set(['left','right']);
const DUAL_ROLE_DATES = new Set(['year','month','day']);

export function emitSqlTokensForGroup(
    builder: vscode.SemanticTokensBuilder,
    group: SqlStringGroup
): void {
    const { stitched, offsetMap } = group;

    const claimed = new Uint8Array(stitched.length);

    function claim(start: number, len: number): void {
        claimed.fill(1, start, start + len);
    }
    function isClaimed(start: number, len: number): boolean {
        const found = claimed.indexOf(1, start);
        return found !== -1 && found < start + len;
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
            emit(bracketStart,             1,                T_SQL_BRACKET_PUNC); // [
            if (m[2].length > 0) { emit(bracketStart + 1,   m[2].length,        T_SQL_COLUMN); }
            emit(bracketStart + bracketLen - 1, 1,           T_SQL_BRACKET_PUNC); // ]
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