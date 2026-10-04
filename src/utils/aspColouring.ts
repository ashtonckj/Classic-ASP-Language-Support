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
import type { FileSymbols } from './symbolParser';
import {
    T_FUNCTION, T_NAMESPACE, T_VARIABLE, T_PARAMETER, T_CONSTANT,
    M_DECLARATION, M_READONLY,
    isSql, isSqlExpression, ALL_SQL_KEYWORDS,
    SqlStringGroup, emitSqlTokensForGroup, TokenSink,
} from '../providers/sqlSemanticProvider';
import type * as A from '../vbscript/ast';
import { parsePage, serverObjects, symbolsOfPage, walkStatements } from '../vbscript/symbols';
import { bindPage, type Scope } from '../vbscript/binder';
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
 * The offset each of the page's lines starts at, split where a TextDocument
 * splits them — at \r\n, \n or a lone \r — so every offset matches the
 * editor's own.
 */
function lineStartsOf(text: string): number[] {
    const starts: number[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch !== 10 && ch !== 13) { continue; }
        starts.push(start);
        if (ch === 13 && text.charCodeAt(i + 1) === 10) { i++; }
        start = i + 1;
    }
    starts.push(start);
    return starts;
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
    // One parse for both the symbols and the SQL passes below.
    const page = parsePage(fullText);
    const allSymbols = withIncludes(symbolsOfPage(page, docPath), request.includeSymbols);

    const lineStarts = lineStartsOf(fullText);

    const tokens: number[] = [];
    const builder: TokenSink = {
        push: (line, char, length, tokenType, tokenModifiers) => {
            tokens.push(line, char, length, tokenType, tokenModifiers);
        },
    };


    // What the page's includes declare, for a name the page itself does not
    // declare. Includes are VBScript through and through, so every name counts.
    const { includeSymbols } = request;
    const includeFunctions = new Map<string, number>();
    for (const fn of includeSymbols.functions) {
        const key = fn.name.toLowerCase();
        if (!includeFunctions.has(key)) { includeFunctions.set(key, fn.kind === 'Function' ? T_FUNCTION : T_NAMESPACE); }
    }
    const includeConstants = new Set(includeSymbols.constants.map(c => c.name.toLowerCase()));
    const includeVariables = new Set([...includeSymbols.variables, ...includeSymbols.comVariables].map(v => v.name.toLowerCase()));

    // ── SQL, read from the syntax tree ───────────────────────────────────
    //
    // A page builds its SQL as a string joined with `&`, often over several
    // lines (`& _`) and in several statements (`sql = sql & " WHERE …"`). The
    // tree holds each joined string as one expression however it is laid out,
    // so these passes work on those expressions: which variables hold SQL,
    // which strings to colour as SQL, and which pieces joined into a SQL
    // variable are not known to be SQL.

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

    // ── VBScript names, from the binder ──────────────────────────────────
    // Each name is coloured as what it refers to in VBScript's own scopes: a
    // local belongs to its Sub, a parameter to its procedure, and `obj.count`
    // is a member, not the variable count. Keywords, strings and comments are
    // not names, so nothing needs stripping first. A name the page declares
    // nowhere takes its colour from what the includes declare.
    const binding = bindPage(docPath, page);
    const pageObjects = new Set(serverObjects(fullText).map(object => object.id.toLowerCase()));
    const serverScope = binding.scopes[0];
    const rootOf = (scope: Scope): Scope => { let s = scope; while (s.parent) { s = s.parent; } return s; };
    for (const r of binding.references) {
        const { line, col } = positionOf(r.span.start);
        const length = r.span.end - r.span.start;
        const declaration = r.declaration ? M_DECLARATION : 0;
        switch (r.target?.kind) {
            case 'function':  builder.push(line, col, length, T_FUNCTION, declaration); continue;
            case 'sub':
            case 'property':  builder.push(line, col, length, T_NAMESPACE, declaration); continue;
            case 'parameter': builder.push(line, col, length, T_PARAMETER, declaration); continue;
            case 'constant':  builder.push(line, col, length, T_CONSTANT, declaration | M_READONLY); continue;
            case 'variable':  builder.push(line, col, length, T_VARIABLE, declaration); continue;
            case 'class':     continue;
        }
        // Includes are pasted into the page's server code only, and `Me.x` names a member.
        if (rootOf(r.scope) !== serverScope || fullText[r.span.start - 1] === '.') { continue; }
        // An object an `<object runat="server">` tag declares, as in global.asa.
        if (pageObjects.has(r.name)) { builder.push(line, col, length, T_VARIABLE, 0); continue; }
        const fn = includeFunctions.get(r.name);
        if (fn !== undefined) { builder.push(line, col, length, fn, 0); }
        else if (includeConstants.has(r.name)) { builder.push(line, col, length, T_CONSTANT, M_READONLY); }
        else if (includeVariables.has(r.name)) { builder.push(line, col, length, T_VARIABLE, 0); }
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
