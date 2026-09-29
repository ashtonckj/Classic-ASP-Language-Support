/**
 * aspColouring.ts  (utils/)
 *
 * The VBScript and SQL colouring of an ASP page, and the SQL warnings that come
 * out of working it out. None of it touches vscode, so it runs on a worker
 * thread, the way the JavaScript colouring does (jsAnalysisWorker.ts): on a
 * large page it is a few hundred milliseconds after every edit, and on the
 * extension host that time held up typing, completion and everything else.
 *
 * In: the page's text and path, and the symbols its includes declare. The
 * page's own symbols are read here, from the text, so the extension host does
 * not parse the page on every edit to send them.
 * Out: the tokens as [line, char, length, type, modifiers] × n in the order
 * they were found, and the SQL warnings as ranges and messages.
 *
 * This file is also the worker's entry point: see the bottom of the file.
 */

import { parentPort } from 'node:worker_threads';
import { extractSymbols, FileSymbols } from './symbolParser';
import { createZoneResolver, getVbScriptBlockRanges } from './zoneUtils';
import { VBSCRIPT_KEYWORDS_SET } from '../constants/aspKeywords';
import {
    T_FUNCTION, T_NAMESPACE, T_VARIABLE, T_PARAMETER, T_CONSTANT,
    M_DECLARATION, M_READONLY,
    isSql, isSqlExpression, ALL_SQL_KEYWORDS,
    SqlStringGroup, emitSqlTokensForGroup, TokenSink,
} from '../providers/sqlSemanticProvider';
import type * as A from '../vbscript/ast';
import { parsePage, walkStatements } from '../vbscript/symbols';
import {
    concatOperands, isConcat, isStringLiteral, statementExpressions, stringValue, walkExpression,
} from '../vbscript/expressions';

export interface AspColouringRequest {
    id:             number;
    text:           string;
    docPath:        string;
    includeSymbols: FileSymbols;
}

/** A warning about how a SQL variable is built, as a range on one line. */
export interface SqlWarning {
    line:      number;
    character: number;
    length:    number;
    message:   string;
}

export interface AspColouringResult {
    id:       number;
    /** [line, char, length, type, modifiers] × n. */
    tokens:   Uint32Array;
    warnings: SqlWarning[];
    /** Set when the colouring threw, so the answer is not kept for reuse. */
    failed?:  true;
}

/**
 * The page's lines and the offset each starts at, split where a TextDocument
 * splits them — at \r\n, \n or a lone \r — so every offset matches the
 * editor's own.
 */
function linesOf(text: string): { lines: string[]; starts: number[] } {
    const lines: string[] = [];
    const starts: number[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch !== 10 && ch !== 13) { continue; }
        lines.push(text.slice(start, i));
        starts.push(start);
        if (ch === 13 && text.charCodeAt(i + 1) === 10) { i++; }
        start = i + 1;
    }
    lines.push(text.slice(start));
    starts.push(start);
    return { lines, starts };
}

/** The page's own symbols followed by its includes', in the order collectAllSymbols gives them. */
function withIncludes(own: FileSymbols, includes: FileSymbols): FileSymbols {
    own.variables.push(...includes.variables);
    own.constants.push(...includes.constants);
    own.functions.push(...includes.functions);
    own.comVariables.push(...includes.comVariables);
    own.classes.push(...includes.classes);
    return own;
}

export function colourAspPage(request: AspColouringRequest): AspColouringResult {
    const { text: fullText, docPath } = request;
    const allSymbols = withIncludes(extractSymbols(fullText, docPath), request.includeSymbols);

    const { lines, starts: lineStarts } = linesOf(fullText);

    const tokens: number[] = [];
    const builder: TokenSink = {
        push: (line, char, length, tokenType, tokenModifiers) => {
            tokens.push(line, char, length, tokenType, tokenModifiers);
        },
    };


    // Build a per-character ASP-zone bitmap once from the raw text.
    // inAsp(offset) scans backwards on every call — O(distance to nearest
    // boundary). At 4k lines that's ~96k calls × avg half-file scan ≈ very slow.
    // aspMap[offset] === 1 replaces every hot-path call with a single array lookup.
    const aspMap = new Uint8Array(fullText.length);
    {
        let inside = false;
        for (let i = 0; i < fullText.length; i++) {
            if (!inside && fullText[i] === '<' && i + 1 < fullText.length && fullText[i + 1] === '%') {
                inside = true; aspMap[i] = 1; i++; aspMap[i] = 1;
            } else if (inside && fullText[i] === '%' && i + 1 < fullText.length && fullText[i + 1] === '>') {
                inside = false; i++;
            } else if (inside) {
                aspMap[i] = 1;
            }
        }
        // Also mark the body of every VBScript <script> block as ASP zone, so
        // semantic tokens are emitted for the VBScript in it.
        //
        // getVbScriptBlockRanges is the same scanner getZone uses, so the two
        // agree on where a block starts and ends. A blind regex over the whole
        // document used to do this, and it had two failure modes:
        //   • it matched a `<script language="vbscript">` that was only TEXT —
        //     written in an HTML comment, or inside a VBScript string — and
        //     coloured everything up to the next `</script>` as VBScript;
        //   • it located the body with indexOf of the body text within the whole
        //     match, so a body that also appeared in an attribute value
        //     (`<script language="vbscript" title="x=1">x=1</script>`) marked the
        //     attribute instead of the body.
        for (const { start, end } of getVbScriptBlockRanges(fullText)) {
            for (let i = start; i < end; i++) { aspMap[i] = 1; }
        }
    }
    const inAsp = (offset: number): boolean => aspMap[offset] === 1;

    // Build fast lookup sets/maps from collected symbols.
    //
    // extractSymbols() has no zone awareness — it collects every symbol it
    // finds in the raw text, including symbols declared inside <script> (JS)
    // blocks.  We must filter those out here before building the colouring
    // sets, otherwise a JS identifier that shares a name with a VBScript one
    // will receive the wrong colour (e.g. a JS param colouring a Dim variable).
    //
    // Symbols from #include files always come from pure VBScript files so
    // they are never zone-filtered — only same-document symbols need the check.

    // One scan for the whole run. isJsZoneSymbol is asked once per collected
    // symbol — ~184 times on a large page — and getZone answers each call by
    // rescanning the document from offset 0, which was ~275ms of every
    // semantic-tokens pass on its own.
    const zones = createZoneResolver(fullText);

    // Returns true when a same-document symbol sits inside a JS <script> block.
    function isJsZoneSymbol(filePath: string, line: number): boolean {
        if (filePath !== docPath) { return false; }
        return zones.zoneAt(lineStarts[line]) === 'js';
    }

    const funcMap = new Map<string, 'function' | 'Sub'>();
    for (const fn of allSymbols.functions) {
        if (isJsZoneSymbol(fn.filePath, fn.line)) { continue; }
        funcMap.set(fn.name.toLowerCase(), fn.kind === 'Function' ? 'function' : 'Sub');
    }

    const varSet = new Set<string>(
        allSymbols.variables
            .filter(v => !isJsZoneSymbol(v.filePath, v.line))
            .map(v => v.name.toLowerCase())
    );
    const comVarSet = new Set<string>(
        allSymbols.comVariables
            .filter(cv => !isJsZoneSymbol(cv.filePath, cv.line))
            .map(cv => cv.name.toLowerCase())
    );
    const constSet = new Set<string>(
        allSymbols.constants
            .filter(c => !isJsZoneSymbol(c.filePath, c.line))
            .map(c => c.name.toLowerCase())
    );

    // Parameter scoping: lineNumber -> Set<paramName>
    // Only register VBScript function params — JS function params must not
    // bleed into ASP lines that happen to share the same line-number range.
    const lineCount = lines.length;
    const lineParamSets: Map<number, Set<string>> = new Map();
    for (const fn of allSymbols.functions) {
        if (fn.paramNames.length === 0)           { continue; }
        if (fn.filePath !== docPath)               { continue; }
        if (isJsZoneSymbol(fn.filePath, fn.line)) { continue; }
        const start = fn.line;
        const end   = fn.endLine !== -1 ? fn.endLine : lineCount - 1;
        for (let l = start; l <= end; l++) {
            if (!lineParamSets.has(l)) { lineParamSets.set(l, new Set()); }
            for (const p of fn.paramNames) { lineParamSets.get(l)!.add(p.toLowerCase()); }
        }
    }

    // Line text and offset caches, used by all the passes below.
    const lineTextCache: string[] = new Array(lineCount);
    const lineOffsetCache: number[] = new Array(lineCount);
    for (let li = 0; li < lineCount; li++) {
        lineTextCache[li]   = lines[li];
        lineOffsetCache[li] = lineStarts[li];
    }

    // ── SQL, read from the syntax tree ───────────────────────────────────
    //
    // A page builds its SQL as a string joined with `&`, often over several
    // lines (`& _`) and in several statements (`sql = sql & " WHERE …"`). The
    // tree holds each joined string as one expression however it is laid out,
    // so these passes work on those expressions: which variables hold SQL,
    // which strings to colour as SQL, and which pieces joined into a SQL
    // variable are not known to be SQL.
    const page = parsePage(fullText);

    /** 0-based line and column of an offset, on the lines the editor counts. */
    function positionOf(offset: number): { line: number; col: number } {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
        }
        return { line: lo, col: offset - lineStarts[lo] };
    }

    function isSqlOrFragment(t: string): boolean {
        return isSql(t) || /^\s*EXEC(?:UTE)?\s+/i.test(t);
    }

    const SQL_FRAGMENT_STARTERS = /^\s*(WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|JOIN\b|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|UNION(\s+ALL)?|WHEN\s+(MATCHED|NOT\s+MATCHED))\s+(?:[@\[a-zA-Z_]|\d)/i;
    // AND/OR/SET fragments: require an identifier then a comparison operator or SQL keyword.
    // This prevents plain English like "OR later", "Set status to approved", "AND the rest"
    // from being mistaken for SQL clause fragments.
    const AND_OR_SET_FRAGMENT = /^\s*(AND|OR|SET)\s+(?:[@\[a-zA-Z_][\w\]]*)\s*(?:[=<>!]|\s+(?:IS|LIKE|IN|BETWEEN|NOT)\b)/i;
    // ON fragments: require identifier = or identifier. (dot notation) pattern.
    const ON_FRAGMENT = /^\s*ON\s+(?:[@\[a-zA-Z_]\w*\s*[=<>!]|[@\[a-zA-Z_]\w*\.)/i;
    function isSqlClauseFragment(t: string): boolean {
        return SQL_FRAGMENT_STARTERS.test(t) || AND_OR_SET_FRAGMENT.test(t) || ON_FRAGMENT.test(t);
    }
    const looksLikeSql = (t: string) => isSqlOrFragment(t) || isSqlClauseFragment(t);

    /** `name = …` without Set, and what the right side joins together. */
    interface Assignment {
        stmt:          A.AssignStmt;
        name:          string;
        written:       string;
        procedure:     A.ProcedureStmt | null;
        operands:      A.Expr[];
        /** The string literals joined, each read as its value, with a space between. */
        stitchedValue: string;
        /** `sql = sql & …`. */
        isSelfAppend:  boolean;
    }

    const statements: A.Stmt[] = [];
    const procedureOf = new Map<A.Stmt, A.ProcedureStmt | null>();
    for (const program of page.programs) {
        walkStatements(program.body, (stmt, procedure) => { statements.push(stmt); procedureOf.set(stmt, procedure); });
    }

    // A blank line after `& _` ends the statement, which VBScript reports as
    // an error, and the rest of the string is left standing on its own. While
    // the page is being fixed, the pieces are still read as the one string
    // they were meant to be, so its colour does not come and go.
    const joined = new Map<A.Expr, A.Expr[]>();
    const continuations = new Set<A.Stmt>();
    const isCut = (operands: A.Expr[]) => operands[operands.length - 1].kind === 'Missing';
    statements.forEach((stmt, i) => {
        const value = stmt.kind === 'Assign' ? stmt.value : stmt.kind === 'Error' ? stmt.expr : undefined;
        if (!value || continuations.has(stmt)) { return; }
        let operands = concatOperands(value);
        for (let next = statements[i + 1]; isCut(operands) && next?.kind === 'Error' && next.expr; next = statements[++i + 1]) {
            operands = [...operands.slice(0, -1), ...concatOperands(next.expr)];
            continuations.add(next);
        }
        joined.set(value, operands);
    });

    /**
     * The strings a piece of a join puts in the result. A method's result is
     * not the string handed to it — `n = conn.Execute("SELECT …")(0)` does not
     * make n SQL — but a function like Replace returns its first argument,
     * changed, so `sql = Replace("SELECT … {0}", "{0}", id)` does.
     */
    const valueStrings = (operand: A.Expr): A.LiteralExpr[] => {
        if (isStringLiteral(operand)) { return [operand]; }
        const first = operand.kind === 'Call' && operand.callee.kind === 'Ident' ? operand.args[0] : null;
        return first ? concatOperands(first).flatMap(valueStrings) : [];
    };

    const assignments: Assignment[] = [];
    for (const stmt of statements) {
        if (stmt.kind !== 'Assign' || stmt.set || stmt.target.kind !== 'Ident') { continue; }
        const operands = joined.get(stmt.value)!;
        const name = stmt.target.name.name;
        const first = operands[0];
        assignments.push({
            stmt, name, written: stmt.target.name.text, procedure: procedureOf.get(stmt) ?? null, operands,
            stitchedValue: operands.flatMap(valueStrings).map(stringValue).join(' '),
            isSelfAppend: operands.length > 1 && first.kind === 'Ident' && first.name.name === name,
        });
    }

    // The assignments of each variable that put a string in it.
    const assignmentMap = new Map<string, Assignment[]>();
    for (const a of assignments) {
        if (!a.stitchedValue) { continue; }
        const list = assignmentMap.get(a.name);
        if (list) { list.push(a); } else { assignmentMap.set(a.name, [a]); }
    }

    // Sub-pass 1: direct SQL assignments
    const sqlVars = new Set<string>();
    for (const [varName, list] of assignmentMap) {
        if (list.some(a => !a.isSelfAppend && looksLikeSql(a.stitchedValue))) { sqlVars.add(varName); }
    }

    // Sub-pass 2: self-append propagation — repeat until stable.
    // A variable qualifies only when:
    //   (a) it has at least one self-append, AND
    //   (b) it has at least one non-self-append assignment that is confirmed SQL
    //       (this is the "seed" — a variable with ONLY self-appends and no fresh
    //       SQL assignment can never be promoted to a SQL variable), AND
    //   (c) every non-self-append assignment looks like SQL, AND
    //   (d) at least one appended string contains SQL content.
    let changed = true;
    while (changed) {
        changed = false;
        for (const [varName, list] of assignmentMap) {
            if (sqlVars.has(varName)) { continue; }
            const selfAssigns    = list.filter(a =>  a.isSelfAppend);
            const nonSelfAssigns = list.filter(a => !a.isSelfAppend);
            if (selfAssigns.length === 0 || nonSelfAssigns.length === 0) { continue; }
            if (!nonSelfAssigns.every(a => looksLikeSql(a.stitchedValue))) { continue; }
            if (!list.some(a => looksLikeSql(a.stitchedValue))) { continue; }
            sqlVars.add(varName);
            changed = true;
        }
    }

    // ── Sub-pass 2b: SQL expression fragment promotion ───────────────────────
    // Variables like nameExpr = "LTRIM(RTRIM(SUBSTRING(...)))" hold pure SQL
    // expressions that are joined into confirmed SQL variables:
    //   subQuery = "(SELECT " & nameExpr & " AS Name, " & _
    //              codeExpr & ...
    // A name used anywhere in the right side of a SQL variable's assignment
    // counts, on whichever line of it the name sits.
    const sqlExprPromoted = new Set<string>();
    {
        const candidates = new Set<string>();
        for (const [varName, list] of assignmentMap) {
            if (!sqlVars.has(varName) && list.some(a => !a.isSelfAppend && isSqlExpression(a.stitchedValue))) {
                candidates.add(varName);
            }
        }
        if (candidates.size > 0) {
            for (const a of assignments) {
                if (!sqlVars.has(a.name)) { continue; }
                walkExpression(a.stmt.value, e => {
                    if (e.kind === 'Ident' && candidates.has(e.name.name)) {
                        sqlVars.add(e.name.name);
                        sqlExprPromoted.add(e.name.name);
                    }
                });
            }
        }
    }

    // ── Sub-pass 3: SQL function return analysis ──────────────────────────
    // A Function returns a value by assigning its own name: GetSql = "…".
    //
    // Result sets:
    //   sqlFuncs      — functions confirmed to return SQL
    //   nonStrFuncs   — functions that never assign a return value at all
    //
    // A function that returns a string that does not look like SQL is left out
    // of both, so it is only warned about where it is joined into SQL.
    const sqlFuncs    = new Set<string>();
    const nonStrFuncs = new Set<string>();
    for (const stmt of statements) {
        if (stmt.kind !== 'Procedure' || stmt.procKind !== 'function' || !stmt.closer) { continue; }
        const returns = assignments.filter(a => a.procedure === stmt && a.name === stmt.name.name);
        if (returns.some(a => a.stitchedValue && looksLikeSql(a.stitchedValue))) {
            sqlFuncs.add(stmt.name.name);
        } else if (returns.length === 0) {
            nonStrFuncs.add(stmt.name.name);
        }
    }

    // ── SQL variable reuse diagnostics ────────────────────────────────────
    // Warn when a known SQL variable is assigned a plain non-SQL string.
    const warnings: SqlWarning[] = [];
    const warnAt = (offset: number, length: number, message: string) => {
        const { line, col } = positionOf(offset);
        warnings.push({ line, character: col, length, message });
    };

    for (const [varName, list] of assignmentMap) {
        // A variable promoted as a SQL expression holds SUBSTRING, CHARINDEX and
        // the like, which isSql does not accept, so warning about it is wrong.
        if (!sqlVars.has(varName) || sqlExprPromoted.has(varName)) { continue; }
        for (const a of list) {
            if (a.isSelfAppend || looksLikeSql(a.stitchedValue) || isSqlExpression(a.stitchedValue)) { continue; }
            warnAt(a.stmt.target.start, a.written.length,
                `'${a.written}' is already marked as a SQL variable. Highlighting may be incorrect.`);
        }
    }

    // ── Pass B: warn on non-SQL variables/functions concatenated into SQL ─
    //
    // For every assignment to a SQL variable, each piece it joins in that is
    //   (a) a variable NOT in sqlVars, or
    //   (b) a call of a function NOT in sqlFuncs.
    //
    // We skip:
    //   • the variable itself (sql = sql & …)
    //   • known SQL keywords written as bare words
    //   • names declared nowhere the page can see — too noisy
    //   • a piece with a string on both sides, `"… id = " & id & " AND …"`,
    //     which puts a value into the SQL, not SQL structure
    //   • names inside a call's arguments, which are values too
    // Functions in nonStrFuncs get a stronger "not a string" warning.
    const knownSymbols = new Set<string>([
        ...allSymbols.variables.map(v => v.name.toLowerCase()),
        ...allSymbols.comVariables.map(cv => cv.name.toLowerCase()),
        ...allSymbols.constants.map(c => c.name.toLowerCase()),
        ...allSymbols.functions.map(f => f.name.toLowerCase()),
    ]);

    for (const a of assignments) {
        if (!sqlVars.has(a.name)) { continue; }
        a.operands.forEach((operand, k) => {
            const isCall = operand.kind === 'Call' && operand.callee.kind === 'Ident';
            const ident = isCall ? (operand as A.CallExpr).callee as A.IdentExpr : operand.kind === 'Ident' ? operand : null;
            if (!ident) { return; }

            const word    = ident.name.text;
            const wordKey = ident.name.name;
            if (wordKey === a.name || ALL_SQL_KEYWORDS.has(wordKey) || !knownSymbols.has(wordKey)) { return; }

            const before = a.operands[k - 1];
            const after  = a.operands[k + 1];
            if (before && after && isStringLiteral(before) && isStringLiteral(after)) { return; }

            if (isCall) {
                if (sqlFuncs.has(wordKey)) { return; }
                warnAt(ident.start, word.length, nonStrFuncs.has(wordKey)
                    ? `'${word}()' does not appear to return a string. ` +
                      `Concatenating it into a SQL variable may produce unexpected results.`
                    : `'${word}()' is concatenated into SQL variable '${a.written}' ` +
                      `but its return value could not be confirmed as a SQL string. ` +
                      `Verify that it returns valid SQL or a safe SQL fragment.`);
            } else if (!sqlVars.has(wordKey)) {
                warnAt(ident.start, word.length,
                    `'${word}' is concatenated into SQL variable '${a.written}' ` +
                    `but has not been confirmed as a SQL variable or fragment. ` +
                    `If this is intentional (e.g. a WHERE clause fragment), ` +
                    `initialise '${word}' with a SQL keyword like WHERE or AND.`);
            }
        });
    }

    // ── SQL strings ───────────────────────────────────────────────────────
    // Each string joined with `&` is read as one: it is coloured as SQL when
    // it reads as SQL, or, piece by piece, when it is written into a SQL
    // variable or returned by a SQL function, as a fragment of that SQL.
    const sqlStringLines = new Map<number, Array<[number, number]>>();

    /** The literals as one SQL string, mapped back to where each character is written. */
    function colourAsSql(literals: A.LiteralExpr[]): void {
        let stitched = '';
        const omLineArr: number[] = [];
        const omColArr:  number[] = [];
        for (const literal of literals) {
            const { raw } = literal;
            if (raw.length < 2 || !raw.endsWith('"')) { continue; }
            const { line, col } = positionOf(literal.start);
            if (stitched.length > 0) { omLineArr.push(line); omColArr.push(col + 1); stitched += ' '; }
            for (let i = 1; i < raw.length - 1; i++) {
                omLineArr.push(line); omColArr.push(col + i);
                stitched += raw[i];
                if (raw[i] === '"') { i++; }
            }
            const ranges = sqlStringLines.get(line);
            if (ranges) { ranges.push([col + 1, col + raw.length - 1]); } else { sqlStringLines.set(line, [[col + 1, col + raw.length - 1]]); }
        }
        if (stitched.length === 0) { return; }
        emitSqlTokensForGroup(builder, { stitched, omLine: Int32Array.from(omLineArr), omCol: Int32Array.from(omColArr) });
    }

    // What each joined string is the right side of, when that is a SQL variable's assignment.
    const writesSql = new Set<A.Expr>();
    for (const a of assignments) {
        if (sqlVars.has(a.name) || sqlFuncs.has(a.name)) { writesSql.add(a.stmt.value); }
    }

    const colourJoined = (e: A.Expr): boolean | void => {
        if (!isConcat(e) && !isStringLiteral(e)) { return; }
        const operands = joined.get(e) ?? concatOperands(e);
        const literals = operands.filter(isStringLiteral);
        if (isSql(literals.map(stringValue).join(' '))) {
            colourAsSql(literals);
        } else if (writesSql.has(e)) {
            for (const literal of literals) { colourAsSql([literal]); }
        }
        // The pieces that are not strings may hold strings of their own, such
        // as the query handed to a call inside the join.
        for (const operand of operands) {
            if (!isStringLiteral(operand)) { walkExpression(operand, colourJoined); }
        }
        return false;
    };
    for (const stmt of statements) {
        if (continuations.has(stmt)) { continue; }
        for (const e of statementExpressions(stmt)) { walkExpression(e, colourJoined); }
    }

    // ── VBScript identifier pass ──────────────────────────────────────────
    // Lines are NOT skipped by a single midpoint ASP-zone check because a
    // line like  <td><%= userName %></td>  or  value="<%= x %>"  has its
    // midpoint in HTML, yet still contains valid ASP tokens that must be
    // coloured.  Instead, each token's actual document offset is checked
    // individually so mixed HTML/ASP lines are handled correctly.
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
        const line       = lineTextCache[lineIndex];
        const lineOffset = lineOffsetCache[lineIndex];

        // Fast pre-filter: skip lines that contain no <% at all.
        if (!line.includes('<%') && !inAsp(lineOffset)) { continue; }

        const trimmed = line.trimStart();
        if (trimmed.startsWith("'") || /^rem\s/i.test(trimmed)) { continue; }

        // Strip VBScript string literals ("...") only when the opening quote
        // is itself inside an ASP block — this preserves HTML attribute values
        // like value="<%= x %>" and onclick="..." so tokens inside remain visible.
        // Replacement is always the same length (spaces) so string offsets stay valid.
        let strippedLine = line.replace(/"[^"]*"/g, (m: string, offset: number) =>
            inAsp(lineOffset + offset) ? ' '.repeat(m.length) : m
        );
        // Only treat ' as a VBScript comment marker when it sits inside an
        // ASP block — a ' in HTML (e.g. onclick="alert('<%= x %>')") is a JS
        // string delimiter and must not truncate the rest of the line.
        // Scan past any leading ' chars that are in HTML to find the first
        // one that genuinely opens a VBScript comment.
        {
            let searchFrom = 0;
            while (true) {
                const qi = strippedLine.indexOf("'", searchFrom);
                if (qi === -1) break;
                if (inAsp(lineOffset + qi)) {
                    strippedLine = strippedLine.substring(0, qi);
                    break;
                }
                searchFrom = qi + 1;
            }
        }

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

            // Per-token zone check — only colour tokens that actually sit
            // inside an ASP block, handles inline <%= %> in HTML attributes.
            if (!inAsp(lineOffset + col)) { continue; }

            if (sqlRanges?.some(([s, e]) => col >= s && col < e)) { continue; }
            if (VBSCRIPT_KEYWORDS_SET.has(wordKey)) { continue; }

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


    return { id: request.id, tokens: Uint32Array.from(tokens), warnings };
}

// ── Worker entry point ───────────────────────────────────────────────────────
// Running as a worker thread, this file answers colouring requests. Imported
// anywhere else (the tests do), parentPort is null and this does nothing.
parentPort?.on('message', (request: AspColouringRequest) => {
    let result: AspColouringResult;
    try {
        result = colourAspPage(request);
    } catch {
        // A half-typed page that trips a pass must cost this one refresh of the
        // colours, not the worker.
        result = { id: request.id, tokens: new Uint32Array(), warnings: [], failed: true };
    }
    // The tokens are handed over, not copied: on a large page they run to
    // hundreds of thousands of numbers.
    parentPort?.postMessage(result, [result.tokens.buffer as ArrayBuffer]);
});
