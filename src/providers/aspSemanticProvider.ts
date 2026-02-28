import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import { isInsideAspBlock } from '../utils/documentHelper';

// ─────────────────────────────────────────────────────────────────────────────
// Semantic token legend — must match contributes.semanticTokenScopes in package.json
//
// Token types (index order matters — must match the array below):
//   0  function         → user-defined Function names
//   1  namespace        → user-defined Sub names
//   2  variable         → Dim'd variables and COM object variables
//   3  parameter        → function/sub parameters inside their own function body
//   4  enumMember       → Const values
//
// SQL token types (indices 5–16):
//   5  sqlDml           → SELECT, INSERT, UPDATE, DELETE, FROM, WHERE, JOIN …
//                         maps to → keyword.other.DML.sql
//   6  sqlDdl           → CREATE, DROP, ALTER, TABLE …
//                         maps to → keyword.other.DDL.sql
//   7  sqlLogical       → AND, OR, NOT, IN, IS, LIKE, BETWEEN, EXISTS …
//                         maps to → keyword.operator.logical.sql
//   8  sqlKeyword       → AS, SET, VALUES, CASE, WHEN, THEN, BEGIN, DECLARE …
//                         maps to → keyword.other.sql
//   9  sqlFunction      → COUNT, SUM, AVG, CONVERT, GETDATE, ISNULL …
//                         maps to → support.function.aggregate.sql
//  10  sqlType          → VARCHAR, INT, DATETIME, BIT …
//                         maps to → storage.type.sql
//  11  sqlVariable      → @paramName
//                         maps to → variable.parameter.sql
//  12  sqlNumber        → numeric literals  1, 42, 3.14 …
//                         maps to → constant.numeric.sql
//  13  sqlBracketPunct  → the [ and ] characters themselves
//                         maps to → constant.numeric.sql  (orange, same as tmLanguage)
//  14  sqlBracketContent → text inside [brackets] AND bare-word table names/aliases
//                         maps to → entity.name.type.class.sql
//  15  sqlTable         → left-hand side of table.column dot refs (alias.column)
//                         maps to → variable.other.table.sql
//  15  sqlTable         → bare-word table names and aliases (context-detected)
//                         maps to → variable.other.table.sql
//  16  sqlColumn        → right-hand side of alias.column  e.g. "RowID" in u.RowID
//                         maps to → variable.other.column.sql
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
const T_SQL_TABLE        = 15;
const T_SQL_COLUMN       = 16;

// Token modifier bit masks
const M_DECLARATION = 1;
const M_READONLY    = 2;

// ─────────────────────────────────────────────────────────────────────────────
// SQL detection — requires BOTH a DML/DDL verb AND a clause keyword.
// Extra guard: FROM followed by an English article (the/a/an/this/that/my/your etc.)
// is plain English, not SQL — e.g. "Select an option from the list".
// ─────────────────────────────────────────────────────────────────────────────
const SQL_VERBS   = /\b(SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE|CREATE|DROP|ALTER|TRUNCATE|MERGE)\b/i;
const SQL_CLAUSES = /\b(FROM|INTO|TABLE|SET|VALUES|WHERE|JOIN|UNION|HAVING|GROUP\s+BY|ORDER\s+BY|RETURNING|DECLARE|BEGIN\s+TRAN|COMMIT|ROLLBACK)\b/i;
const ENGLISH_ARTICLES = /^(the|a|an|this|that|these|those|my|your|our|their|its|her|his)$/i;

function isSql(text: string): boolean {
    if (!SQL_VERBS.test(text) || !SQL_CLAUSES.test(text)) { return false; }
    // If FROM is followed by an article, check if any other clause keyword exists
    const fromMatch = text.match(/\bFROM\s+(\w+)/i);
    if (fromMatch && ENGLISH_ARTICLES.test(fromMatch[1])) {
        const withoutFrom = text.replace(/\bFROM\s+\w+/gi, '');
        if (!SQL_CLAUSES.test(withoutFrom)) { return false; }
    }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL keyword sets — each mirrors the exact tmLanguage sql-syntax scope
// so semantic tokens resolve to the same colour as the grammar would apply.
// ─────────────────────────────────────────────────────────────────────────────
const SQL_DML_WORDS = new Set([
    'select','insert','update','delete','merge','output','exec','execute',
    'from','where','join','on','using','having','distinct','top','limit',
    'offset','fetch','union','intersect','except','by','order','group',
    'apply','matched','ties','with',
    'left','right','inner','outer','full','cross',
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
]);
const SQL_FUNCTION_WORDS = new Set([
    'count','sum','avg','max','min','row_number','rank','dense_rank','ntile',
    'partition','over','lead','lag','first_value','last_value',
    'substring','len','length','upper','lower','trim','ltrim','rtrim','concat',
    'concat_ws','replace','charindex','patindex','stuff','left','right',
    'reverse','replicate','space','soundex','difference','ascii','char',
    'nchar','unicode','quotename',
    'getdate','getutcdate','sysdatetime','sysutcdatetime','sysdatetimeoffset',
    'current_timestamp','dateadd','datediff','datediff_big','datepart',
    'datename','year','month','day','hour','minute','second','millisecond',
    'microsecond','nanosecond','dayofweek','dayofyear','week','weekday',
    'quarter','convert','cast','format','try_cast','try_convert','parse',
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

// All SQL keywords combined — used to prevent bare words from being
// mistaken for table names or aliases when they are actually keywords.
const ALL_SQL_KEYWORDS = new Set([
    ...SQL_DML_WORDS, ...SQL_DDL_WORDS, ...SQL_LOGICAL_WORDS,
    ...SQL_KEYWORD_WORDS, ...SQL_FUNCTION_WORDS, ...SQL_TYPE_WORDS,
    'temp','temporary','exists','table',
]);

function sqlWordTokenType(word: string): number | null {
    const w = word.toLowerCase();
    if (SQL_DML_WORDS.has(w))      { return T_SQL_DML; }
    if (SQL_DDL_WORDS.has(w))      { return T_SQL_DDL; }
    if (SQL_LOGICAL_WORDS.has(w))  { return T_SQL_LOGICAL; }
    if (SQL_KEYWORD_WORDS.has(w))  { return T_SQL_KEYWORD; }
    if (SQL_FUNCTION_WORDS.has(w)) { return T_SQL_FUNC; }
    if (SQL_TYPE_WORDS.has(w))     { return T_SQL_TYPE; }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL tokeniser — converts a raw SQL string into a flat token list.
// Each token has: type, value, and offset (position in the original string).
// ─────────────────────────────────────────────────────────────────────────────
type SqlTokType = 'bracket' | 'word' | 'dot' | 'num' | 'comma' | 'paren' | 'ws' | 'other';
interface SqlTok { type: SqlTokType; val: string; off: number; }

function tokeniseSql(sql: string): SqlTok[] {
    const tokens: SqlTok[] = [];
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];

        // Bracketed identifier [...]
        if (ch === '[') {
            const close = sql.indexOf(']', i);
            const end   = close === -1 ? sql.length : close + 1;
            tokens.push({ type: 'bracket', val: sql.slice(i, end), off: i });
            i = end;
            continue;
        }
        // Word (including # prefix for temp tables like #TempTable)
        if (/[a-zA-Z_#]/.test(ch)) {
            const m = sql.slice(i).match(/^[a-zA-Z_#][a-zA-Z0-9_#]*/);
            const w = m![0];
            tokens.push({ type: 'word', val: w, off: i });
            i += w.length;
            continue;
        }
        // Number
        if (/\d/.test(ch)) {
            const m = sql.slice(i).match(/^\d+(\.\d+)?([eE][+-]?\d+)?/);
            const n = m![0];
            tokens.push({ type: 'num', val: n, off: i });
            i += n.length;
            continue;
        }
        // Single-char tokens
        if (ch === '.') { tokens.push({ type: 'dot',   val: ch, off: i }); i++; continue; }
        if (ch === ',') { tokens.push({ type: 'comma', val: ch, off: i }); i++; continue; }
        if (ch === '(' || ch === ')') { tokens.push({ type: 'paren', val: ch, off: i }); i++; continue; }
        if (/\s/.test(ch)) {
            const m = sql.slice(i).match(/^\s+/);
            tokens.push({ type: 'ws', val: m![0], off: i });
            i += m![0].length;
            continue;
        }
        tokens.push({ type: 'other', val: ch, off: i });
        i++;
    }
    return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context-aware table name detector.
//
// Scans the significant (non-whitespace) token stream of a stitched SQL string
// and returns a Set of [offset, length] pairs for every character range that
// is a confirmed table name or table alias.
//
// Detects table names after:
//   FROM   <table> [alias]
//   JOIN   <table> [alias]   (all variants — LEFT/RIGHT/INNER/OUTER/FULL/CROSS)
//   INTO   <table>           (INSERT INTO)
//   UPDATE <table>           (UPDATE … SET)
//   TRUNCATE TABLE <table>
//   ALTER TABLE <table>
//   DROP TABLE [IF EXISTS] <table>
//   CREATE [TEMP|TEMPORARY] TABLE <table>
//
// WITH is intentionally excluded — the word after WITH is a CTE name, not a table.
//
// A table reference can be a dot-chain of bare words and/or [bracketed] parts,
// e.g.: [ProductionDb].[dbo].[Users]  or  dbo.Orders  or  Orders
// All parts of the chain are coloured as table names.
// An optional alias (bare word that isn't a keyword, or AS <word>) after the
// chain is also coloured as a table name.
// ─────────────────────────────────────────────────────────────────────────────

// join-prefix words that can appear before JOIN
const JOIN_PREFIXES = new Set(['left','right','inner','outer','full','cross','natural']);

// Two-word intros where the second word is TABLE (or TEMP/TEMPORARY before TABLE)
// Returns the index of the token AFTER "TABLE" if matched, or -1.
function matchTwoWordTableIntro(sig: SqlTok[], i: number): number {
    const w = sig[i].val.toLowerCase();
    if (i + 1 >= sig.length) { return -1; }
    const w2 = sig[i + 1].val.toLowerCase();

    // TRUNCATE TABLE / ALTER TABLE
    if ((w === 'truncate' || w === 'alter') && w2 === 'table') {
        return i + 2; // index after TABLE
    }
    // DROP TABLE [IF [NOT] EXISTS]
    if (w === 'drop' && w2 === 'table') {
        let j = i + 2;
        // skip optional IF [NOT] EXISTS
        if (j < sig.length && sig[j].val.toLowerCase() === 'if') { j++; }
        if (j < sig.length && sig[j].val.toLowerCase() === 'not') { j++; }
        if (j < sig.length && sig[j].val.toLowerCase() === 'exists') { j++; }
        return j;
    }
    // CREATE [TEMP|TEMPORARY] TABLE
    if (w === 'create') {
        let j = i + 1;
        if (j < sig.length && sig[j].val.toLowerCase() === 'table') {
            return j + 1;
        }
        if (j < sig.length && sig[j].val.toLowerCase() in { temp: 1, temporary: 1 }) {
            j++;
            if (j < sig.length && sig[j].val.toLowerCase() === 'table') {
                return j + 1;
            }
        }
    }
    return -1;
}

function isIdentifier(tok: SqlTok): boolean {
    return tok.type === 'bracket' || tok.type === 'word';
}

// Collect a dot-chain starting at sig[start] and the optional alias after it.
// Returns an array of {off, len} for every table-name token found.
function collectTableChain(sig: SqlTok[], start: number): Array<{off: number; len: number}> {
    const result: Array<{off: number; len: number}> = [];
    let i = start;

    if (i >= sig.length || !isIdentifier(sig[i])) { return result; }

    // Collect dot-separated chain
    while (i < sig.length && isIdentifier(sig[i])) {
        const tok = sig[i];
        if (tok.type === 'bracket') {
            // Whole bracketed token is a table name part — split into
            // punc + content + punc so colours are applied per-character below.
            result.push({ off: tok.off, len: tok.val.length });
        } else {
            // Bare word — only add if it isn't a SQL keyword
            if (!ALL_SQL_KEYWORDS.has(tok.val.toLowerCase())) {
                result.push({ off: tok.off, len: tok.val.length });
            } else {
                break; // hit a keyword — stop the chain
            }
        }
        i++;
        // Continue if followed by a dot
        if (i < sig.length && sig[i].type === 'dot') {
            i++; // consume the dot
        } else {
            break;
        }
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
    const sig    = all.filter(t => t.type !== 'ws'); // significant tokens only
    const result = new Set<string>();

    function addRanges(ranges: Array<{off: number; len: number}>): void {
        for (const r of ranges) { result.add(`${r.off}:${r.len}`); }
    }

    let i = 0;
    while (i < sig.length) {
        const tok = sig[i];
        if (tok.type !== 'word') { i++; continue; }
        const w = tok.val.toLowerCase();

        // ── Two-word intros: TRUNCATE/ALTER/DROP/CREATE TABLE ─────────────────
        const afterTwoWord = matchTwoWordTableIntro(sig, i);
        if (afterTwoWord !== -1) {
            addRanges(collectTableChain(sig, afterTwoWord));
            i = afterTwoWord + 1;
            continue;
        }

        // ── JOIN (optionally prefixed: LEFT/RIGHT/INNER/OUTER/FULL/CROSS) ─────
        if (JOIN_PREFIXES.has(w) && i + 1 < sig.length && sig[i+1].val.toLowerCase() === 'join') {
            // advance past the prefix to JOIN, then fall through to FROM/JOIN handler
            i++;
        }
        const w2 = sig[i].val.toLowerCase();

        // ── FROM / JOIN ────────────────────────────────────────────────────────
        if (w2 === 'from' || w2 === 'join') {
            addRanges(collectTableChain(sig, i + 1));
            i++;
            continue;
        }

        // ── INTO (INSERT INTO <table>) ─────────────────────────────────────────
        if (w2 === 'into') {
            addRanges(collectTableChain(sig, i + 1));
            i++;
            continue;
        }

        // ── UPDATE <table> ─────────────────────────────────────────────────────
        if (w2 === 'update') {
            addRanges(collectTableChain(sig, i + 1));
            i++;
            continue;
        }

        i++;
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stitch & _ continuation lines and collect per-segment ranges.
// Returns null when the full stitched string is not confirmed SQL.
// Also returns the stitched string and a per-character offset map so
// table ranges found in the stitched string can be mapped back to
// original document line/column positions.
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
    // Maps each character index in `stitched` back to {lineIndex, col}
    offsetMap: Array<{lineIndex: number; col: number}>;
}

function extractSqlGroup(
    document: vscode.TextDocument,
    startLine: number,
    startCol: number
): SqlStringGroup | null {

    // Stitches all "..." string fragments on a line (and across & _ continuation
    // lines) into one string, skipping & variable & gaps between them.

    const lineCount = document.lineCount;
    const segments: SqlStringSegment[] = [];
    let   stitched  = '';
    const offsetMap: Array<{lineIndex: number; col: number}> = [];

    // Helper: read one "..." string fragment at lineText[col] (opening quote).
    // Also returns colOffsets: one entry per content character mapping back to
    // the original line column. Handles "" escaped quotes correctly — a ""
    // produces one content char but advances the line by 2 columns.
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
                    colOffsets.push(col);   // "" → one " in content, maps to first "
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

    // Helper: append a fragment to stitched + offsetMap.
    // Uses frag.colOffsets so each stitched character maps to its exact line column,
    // even when "" escaped quotes make content shorter than the raw line span.
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

    // Helper: check if the rest of a line after col ends with & _
    function lineEndsWithContinuation(lineText: string, col: number): boolean {
        let rest = lineText.substring(col).trimEnd();
        const cp = rest.indexOf("'");
        if (cp !== -1) { rest = rest.substring(0, cp).trimEnd(); }
        return /&\s*_$/.test(rest);
    }

    // Helper: advance past & variable & gaps looking for the next opening quote.
    // Returns the col of the next " or -1 if none found before EOL.
    // Note: we do NOT treat ' as a comment here because SQL strings commonly
    // contain single quotes (e.g. WHERE x = '...') inside the variable gaps.
    function findNextQuote(lineText: string, col: number): number {
        while (col < lineText.length && lineText[col] === ' ') { col++; }
        // Handle continuation lines that start directly with a quote (no & before it)
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

    // ── Step 1: read the first fragment ──────────────────────────────────────
    const firstLine = document.lineAt(startLine).text;
    const firstFrag = readFragment(firstLine, startCol);
    if (!firstFrag) { return null; }

    appendFragment(startLine, firstLine, firstFrag);

    let scanLine = startLine;
    let scanText = firstLine;
    let scanCol  = firstFrag.nextCol;

    // ── Steps 2–4: keep scanning for more fragments ───────────────────────────
    while (true) {
        // Look for more string fragments on the current line after & var & gaps
        const nextQuoteCol = findNextQuote(scanText, scanCol);
        if (nextQuoteCol !== -1) {
            const frag = readFragment(scanText, nextQuoteCol);
            if (frag) {
                appendFragment(scanLine, scanText, frag);
                scanCol = frag.nextCol;
                continue;
            }
        }

        // No more fragments on this line — check for & _ continuation
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

    // claimed[stitchedOffset] = 1 means already emitted
    const claimed = new Uint8Array(stitched.length);

    function claim(start: number, len: number): void {
        for (let i = start; i < start + len && i < claimed.length; i++) { claimed[i] = 1; }
    }
    function isClaimed(start: number, len: number): boolean {
        for (let i = start; i < start + len; i++) {
            if (i < claimed.length && claimed[i]) { return true; }
        }
        return false;
    }

    // Emit one token, mapping stitched offset → real document line/col.
    // Tokens are emitted character-by-character per line because a range might
    // span a line boundary (e.g. continuation) — but in practice each segment
    // is always on one line, so we just look up the first char's line/col.
    function emit(stitchedStart: number, len: number, tokenType: number): void {
        if (stitchedStart >= offsetMap.length) { return; }
        const { lineIndex, col } = offsetMap[stitchedStart];
        builder.push(lineIndex, col, len, tokenType, 0);
    }

    // ── Pass 1: table names ───────────────────────────────────────────────────
    const tableRangeSet = findTableRanges(stitched);

    for (const key of tableRangeSet) {
        const [offStr, lenStr] = key.split(':');
        const off = parseInt(offStr, 10);
        const len = parseInt(lenStr, 10);

        if (isClaimed(off, len)) { continue; }

        const tok = stitched.slice(off, off + len);

        if (tok.startsWith('[') && tok.endsWith(']')) {
            // Bracketed table name: [ and ] get sqlBracketPunct (orange),
            // inner text gets sqlBracketContent (entity.name.type.class.sql).
            emit(off,               1,           T_SQL_BRACKET_PUNC);
            const innerLen = len - 2;
            if (innerLen > 0) {
                emit(off + 1,       innerLen,    T_SQL_BRACKET_CON);
            }
            emit(off + len - 1,     1,           T_SQL_BRACKET_PUNC);
        } else {
            // Bare-word table name or alias — same colour as bracketed inner content
            emit(off, len, T_SQL_BRACKET_CON);
        }
        claim(off, len);
    }

    // ── Pass 2: alias.column dot references ──────────────────────────────────
    // Left side uses T_SQL_BRACKET_CON so u.Name references match the colour
    // of the alias declaration in "FROM dbo.Users u".
    const dotPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(\*|[a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = dotPattern.exec(stitched)) !== null) {
        const tableStart  = m.index;
        const tableLen    = m[1].length;
        const columnStart = tableStart + tableLen + 1;
        const columnLen   = m[2].length;

        if (!isClaimed(tableStart, tableLen)) {
            emit(tableStart, tableLen, T_SQL_BRACKET_CON);
            claim(tableStart, tableLen);
        }
        if (!isClaimed(columnStart, columnLen)) {
            emit(columnStart, columnLen, T_SQL_COLUMN);
            claim(columnStart, columnLen);
        }
    }

    // ── Pass 3: @variable parameters ─────────────────────────────────────────
    const atPattern = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((m = atPattern.exec(stitched)) !== null) {
        if (isClaimed(m.index, m[0].length)) { continue; }
        emit(m.index, m[0].length, T_SQL_VAR);
        claim(m.index, m[0].length);
    }

    // ── Pass 4: numeric literals ──────────────────────────────────────────────
    const numPattern = /\b\d+(\.\d+)?([eE][+-]?\d+)?\b/g;
    while ((m = numPattern.exec(stitched)) !== null) {
        if (isClaimed(m.index, m[0].length)) { continue; }
        emit(m.index, m[0].length, T_SQL_NUMBER);
        claim(m.index, m[0].length);
    }

    // ── Pass 5: SQL keywords / functions / types ──────────────────────────────
    const wordPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    while ((m = wordPattern.exec(stitched)) !== null) {
        if (isClaimed(m.index, m[1].length)) { continue; }
        const tokenType = sqlWordTokenType(m[1]);
        if (tokenType !== null) {
            emit(m.index, m[1].length, tokenType);
            claim(m.index, m[1].length);
        }
    }
}

export class AspSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {

    private readonly _diagnostics: vscode.DiagnosticCollection;

    constructor() {
        // Orange squiggly when a SQL variable is also assigned a plain string.
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

        // ── Build fast lookup sets / maps ─────────────────────────────────────
        const funcMap = new Map<string, 'function' | 'Sub'>();
        for (const fn of allSymbols.functions) {
            funcMap.set(fn.name.toLowerCase(), fn.kind === 'Function' ? 'function' : 'Sub');
        }
        const varSet    = new Set<string>();
        for (const v  of allSymbols.variables)   { varSet.add(v.name.toLowerCase()); }
        const comVarSet = new Set<string>();
        for (const cv of allSymbols.comVariables) { comVarSet.add(cv.name.toLowerCase()); }
        const constSet  = new Set<string>();
        for (const c  of allSymbols.constants)    { constSet.add(c.name.toLowerCase()); }

        // Parameter scoping: lineNumber → Set<paramName>
        const lineCount = document.lineCount;
        const lineParamSets: Map<number, Set<string>> = new Map();
        for (const fn of allSymbols.functions) {
            if (fn.paramNames.length === 0)              { continue; }
            if (fn.filePath !== document.uri.fsPath)     { continue; }
            const start = fn.line;
            const end   = fn.endLine !== -1 ? fn.endLine : lineCount - 1;
            for (let l = start; l <= end; l++) {
                if (!lineParamSets.has(l)) { lineParamSets.set(l, new Set()); }
                for (const p of fn.paramNames) { lineParamSets.get(l)!.add(p.toLowerCase()); }
            }
        }

        // ── Pass A: SQL variable discovery ───────────────────────────────────
        // Find all variables assigned a confirmed SQL string anywhere in the file.
        // Sub-pass 1: direct SQL assignments. Sub-pass 2: self-append propagation.

        // isSqlOrFragment: like isSql() but also accepts EXEC/EXECUTE without a clause,
        // since stored procedure calls are valid SQL but have no FROM/WHERE etc.
        function isSqlOrFragment(text: string): boolean {
            if (isSql(text)) { return true; }
            return /^\s*EXEC(?:UTE)?\s+/i.test(text);
        }

        // Collect every variable assignment that contains at least one string literal.
        // For multi-line & _ continuations, stitch all fragments so isSql() sees
        // the full query (e.g. SELECT on line 1, FROM on line 2).
        interface VarAssignment {
            isSelfAppend:  boolean;
            stitchedValue: string;
        }
        const assignmentMap = new Map<string, VarAssignment[]>();

        const assignPattern = /^\s*([a-zA-Z_]\w*)\s*=\s*(.+)$/;
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

            const selfAppendPattern = new RegExp(
                '^\\b' + varName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\b\\s*&', 'i'
            );
            const isSelfAppend = selfAppendPattern.test(rhs);

            // Find the first " on this line and use extractSqlGroup to stitch
            // all string fragments including & _ continuations on following lines.
            const quoteCol = lineText.indexOf('"', lineText.indexOf(am[1]));
            let stitchedValue = '';

            if (quoteCol !== -1) {
                const group = extractSqlGroup(document, li, quoteCol);
                if (group !== null) {
                    stitchedValue = group.stitched;
                    // Mark continuation lines as processed so we don't double-count
                    for (const seg of group.segments) { processedAssignLines.add(seg.lineIndex); }
                } else {
                    // Not a full SQL group — just collect literals from this line
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

        // Sub-pass 1: find variables directly assigned confirmed SQL
        const sqlVars = new Set<string>();
        for (const [varName, assignments] of assignmentMap) {
            for (const a of assignments) {
                if (!a.isSelfAppend && isSqlOrFragment(a.stitchedValue)) {
                    sqlVars.add(varName);
                    break;
                }
            }
        }

        // Sub-pass 2: if all non-self assignments are SQL and at least one
        // self-append exists, it's also a SQL var. Repeat until stable.
        let changed = true;
        while (changed) {
            changed = false;
            for (const [varName, assignments] of assignmentMap) {
                if (sqlVars.has(varName)) { continue; }
                // Check if ALL non-self-append assignments are SQL,
                // and at least one self-append references a known SQL var
                const nonSelfAssigns = assignments.filter(a => !a.isSelfAppend);
                const selfAssigns    = assignments.filter(a =>  a.isSelfAppend);
                if (selfAssigns.length === 0) { continue; }
                // All non-self assignments (if any) must be SQL
                const allNonSelfAreSql = nonSelfAssigns.every(a => isSql(a.stitchedValue));
                if (!allNonSelfAreSql && nonSelfAssigns.length > 0) { continue; }
                // Mark as SQL var
                sqlVars.add(varName);
                changed = true;
            }
        }

        // ── SQL variable reuse diagnostics ────────────────────────────────────
        // Warn when a known SQL variable is assigned a plain non-SQL string.
        // Uses the stitched values already computed in assignmentMap so multi-line
        // & _ assignments and EXEC statements are evaluated correctly.
        const sqlDiagnostics: vscode.Diagnostic[] = [];

        for (const [varName3, assignments] of assignmentMap) {
            if (!sqlVars.has(varName3)) { continue; }

            for (const a of assignments) {
                // Self-appends are fine — only warn on direct non-SQL assignments
                if (a.isSelfAppend) { continue; }
                if (isSqlOrFragment(a.stitchedValue)) { continue; }

                // This assignment is a direct non-SQL string on a known SQL variable.
                // Find which line it's on by scanning for the assignment pattern.
                const assignLinePattern = /^\s*([a-zA-Z_]\w*)\s*=\s*(.+)$/;
                for (let li = 0; li < lineCount; li++) {
                    const lineText   = document.lineAt(li).text;
                    const lineOffset = document.offsetAt(new vscode.Position(li, 0));
                    const midOffset  = lineOffset + Math.floor(lineText.length / 2);
                    if (!isInsideAspBlock(text, midOffset)) { continue; }

                    let stripped3 = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                    const cp3 = stripped3.indexOf("'");
                    if (cp3 !== -1) { stripped3 = stripped3.substring(0, cp3); }

                    const am3 = assignLinePattern.exec(stripped3);
                    if (!am3 || am3[1].toLowerCase() !== varName3) { continue; }

                    const rhs3 = am3[2].trim();
                    // Skip self-appends on this line
                    const isSelfRef = new RegExp(
                        '^\\b' + varName3.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\b', 'i'
                    ).test(rhs3);
                    if (isSelfRef) { continue; }

                    // Verify this line's literals match the suspicious assignment
                    const sp3 = /"((?:[^"]|"")*)"/g;
                    let sm3: RegExpExecArray | null;
                    const lits3: string[] = [];
                    while ((sm3 = sp3.exec(lineText)) !== null) {
                        lits3.push(sm3[1].replace(/""/g, '"'));
                    }
                    if (lits3.length === 0) { continue; }
                    // Use the stitched value from assignmentMap (not re-collected per-line)
                    // to confirm this is the matching assignment
                    if (lits3.join(' ') !== a.stitchedValue) { continue; }

                    const varCol = lineText.search(new RegExp(
                        '\\b' + varName3.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\b', 'i'
                    ));
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
                    break; // found the line, stop scanning
                }
            }
        }

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

        for (let li = 0; li < lineCount; li++) {
            if (processedSqlLines.has(li)) { continue; }

            const lineText   = document.lineAt(li).text;
            const lineOffset = document.offsetAt(new vscode.Position(li, 0));
            const midOffset  = lineOffset + Math.floor(lineText.length / 2);
            if (!isInsideAspBlock(text, midOffset)) { continue; }

            // Check if this line is an append to a known SQL variable:
            //   sqlVar = sqlVar & "..." or sqlVar & "..." (standalone concat)
            // If so, colour all string literals on this line as SQL.
            let lineIsSqlAppend = false;
            if (sqlVars.size > 0) {
                // Strip strings + comment to check variable names safely
                let stripped2 = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                const cp2 = stripped2.indexOf("'");
                if (cp2 !== -1) { stripped2 = stripped2.substring(0, cp2); }
                // Match: sqlVar = ... & or sqlVar & (append patterns)
                for (const sqlVar of sqlVars) {
                    const escaped = sqlVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    // Pattern: starts with optional whitespace + sqlVar then = or &
                    if (new RegExp('^\\s*' + escaped + '\\s*(?:=|&)', 'i').test(stripped2)) {
                        lineIsSqlAppend = true;
                        break;
                    }
                }
            }

            let col = 0;
            while (col < lineText.length) {
                if (lineText[col] !== '"') { col++; continue; }

                // Try full SQL group detection first (handles multi-line stitching)
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
                    // Not a self-contained SQL string, but it's being appended to
                    // a known SQL variable — colour it as a SQL fragment.
                    col++; // step past opening "
                    const fragStart = col;
                    while (col < lineText.length) {
                        if (lineText[col] === '"') {
                            if (col + 1 < lineText.length && lineText[col + 1] === '"') {
                                col += 2;
                            } else { break; }
                        } else { col++; }
                    }
                    if (col < lineText.length) {
                        emitFragmentAsSql(li, lineText, fragStart, col);
                        col++; // past closing "
                    }
                } else {
                    // Not SQL — skip past this string
                    col++;
                    while (col < lineText.length) {
                        if (lineText[col] === '"') {
                            if (col + 1 < lineText.length && lineText[col + 1] === '"') {
                                col += 2;
                            } else { col++; break; }
                        } else { col++; }
                    }
                }
            }
        }

        // ── VBScript identifier pass ──────────────────────────────────────────
        const lines = text.split('\n');
        lines.forEach((line, lineIndex) => {
            const lineOffset = document.offsetAt(new vscode.Position(lineIndex, 0));
            const midOffset  = lineOffset + Math.floor(line.length / 2);
            if (!isInsideAspBlock(text, midOffset)) { return; }

            const trimmed = line.trimStart();
            if (trimmed.startsWith("'") || /^rem\s/i.test(trimmed)) { return; }

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
                    const modifierMask = isFuncDeclaration ? M_DECLARATION : 0;
                    builder.push(lineIndex, col, word.length, T_PARAMETER, modifierMask);
                    continue;
                }
                if (constSet.has(wordKey)) {
                    const modifierMask = isConstLine ? M_DECLARATION | M_READONLY : M_READONLY;
                    builder.push(lineIndex, col, word.length, T_CONSTANT, modifierMask);
                    continue;
                }
                if (comVarSet.has(wordKey)) {
                    const modifierMask = isSetLine ? M_DECLARATION : 0;
                    builder.push(lineIndex, col, word.length, T_VARIABLE, modifierMask);
                    continue;
                }
                if (varSet.has(wordKey)) {
                    const modifierMask = isDimLine ? M_DECLARATION : 0;
                    builder.push(lineIndex, col, word.length, T_VARIABLE, modifierMask);
                    continue;
                }
            }
        });

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