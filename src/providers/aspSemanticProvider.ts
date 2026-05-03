import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import { getZone } from '../utils/aspUtils';
import { VBSCRIPT_KEYWORDS_SET } from '../constants/aspKeywords';
import {
    T_FUNCTION, T_NAMESPACE, T_VARIABLE, T_PARAMETER, T_CONSTANT,
    M_DECLARATION, M_READONLY,
    isSql, isSqlExpression, ALL_SQL_KEYWORDS,
    SqlStringGroup, SqlStringSegment, extractSqlGroup, emitSqlTokensForGroup,
} from './sqlSemanticProvider';
// Use COMBINED_SEMANTIC_LEGEND from jsSemanticProvider — it now includes the
// SQL token types (indices 23–34) so all three providers (ASP, SQL, JS) share
// one identical legend. VS Code maps token indices through whichever legend is
// registered first; using a different legend here would corrupt all colours.
import { COMBINED_SEMANTIC_LEGEND } from './jsSemanticProvider';
export { COMBINED_SEMANTIC_LEGEND as ASP_SEMANTIC_LEGEND } from './jsSemanticProvider';

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
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SemanticTokens> {

        const builder    = new vscode.SemanticTokensBuilder(COMBINED_SEMANTIC_LEGEND);
        const text       = document.getText();
        const allSymbols = collectAllSymbols(document);

        // Build a per-character ASP-zone bitmap once from the raw text.
        // inAsp(offset) scans backwards on every call — O(distance to nearest
        // boundary). At 4k lines that's ~96k calls × avg half-file scan ≈ very slow.
        // aspMap[offset] === 1 replaces every hot-path call with a single array lookup.
        const aspMap = new Uint8Array(text.length);
        {
            let inside = false;
            for (let i = 0; i < text.length; i++) {
                if (!inside && text[i] === '<' && i + 1 < text.length && text[i + 1] === '%') {
                    inside = true; aspMap[i] = 1; i++; aspMap[i] = 1;
                } else if (inside && text[i] === '%' && i + 1 < text.length && text[i + 1] === '>') {
                    inside = false; i++;
                } else if (inside) {
                    aspMap[i] = 1;
                }
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
        const docPath = document.uri.fsPath;

        // Returns true when a same-document symbol sits inside a JS <script> block.
        function isJsZoneSymbol(filePath: string, line: number): boolean {
            if (filePath !== docPath) { return false; }
            return getZone(text, document.offsetAt(new vscode.Position(line, 0))) === 'js';
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
        const lineCount = document.lineCount;
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

        // Build line text and offset caches once — used by all subsequent passes.
        // This avoids repeated document.lineAt() and document.offsetAt() API calls
        // (each of which crosses the VS Code extension host boundary) in every loop.
        const lineTextCache: string[] = new Array(lineCount);
        const lineOffsetCache: number[] = new Array(lineCount);
        for (let li = 0; li < lineCount; li++) {
            lineTextCache[li]   = document.lineAt(li).text;
            lineOffsetCache[li] = document.offsetAt(new vscode.Position(li, 0));
        }

        // ── Pass A: SQL variable discovery ───────────────────────────────────
        function isSqlOrFragment(t: string): boolean {
            return isSql(t) || /^\s*EXEC(?:UTE)?\s+/i.test(t);
        }

        const SQL_FRAGMENT_STARTERS = /^\s*(WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|JOIN\b|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|UNION(\s+ALL)?|WHEN\s+(MATCHED|NOT\s+MATCHED))\s+(?:[@\[a-zA-Z_]|\d)/i;
        // AND/OR/SET fragments: require an identifier then a comparison operator or SQL keyword.
        // This prevents plain English like "OR shift", "Set status to approved", "AND the employee"
        // from being mistaken for SQL clause fragments.
        const AND_OR_SET_FRAGMENT = /^\s*(AND|OR|SET)\s+(?:[@\[a-zA-Z_][\w\]]*)\s*(?:[=<>!]|\s+(?:IS|LIKE|IN|BETWEEN|NOT)\b)/i;
        // ON fragments: require identifier = or identifier. (dot notation) pattern.
        const ON_FRAGMENT = /^\s*ON\s+(?:[@\[a-zA-Z_]\w*\s*[=<>!]|[@\[a-zA-Z_]\w*\.)/i;
        function isSqlClauseFragment(t: string): boolean {
            return SQL_FRAGMENT_STARTERS.test(t) || AND_OR_SET_FRAGMENT.test(t) || ON_FRAGMENT.test(t);
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

            const lineText   = lineTextCache[li];
            const lineOffset = lineOffsetCache[li];
            const midOffset  = lineOffset + Math.floor(lineText.length / 2);
            if (!inAsp(midOffset)) { continue; }

            const trimmedForComment733 = lineText.trimStart();
            if (trimmedForComment733.startsWith("'") || /^rem\s/i.test(trimmedForComment733)) { continue; }

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
            } else {
                // No string literal on the assignment line itself — the RHS may be:
                //   (a) a function call like BuildBOMCTE(...) & _  (has & before _)
                //   (b) a plain line continuation: dataStmt = _    (just = then _)
                // Both patterns continue on the next line(s) with string literals.
                const rhsTrimmed = lineText.trimEnd();
                const endsWithContinuation = rhsTrimmed.endsWith('_');
                const hasAmpersandBeforeUnderscore = rhsTrimmed.slice(0, -1).trimEnd().endsWith('&');
                // Also accept: assignment RHS is just `_` (i.e. the value starts on next line)
                const isPlainContinuation = endsWithContinuation && !hasAmpersandBeforeUnderscore &&
                    /=\s*_\s*$/.test(rhsTrimmed);
                if (endsWithContinuation && (hasAmpersandBeforeUnderscore || isPlainContinuation)) {
                    for (let scanLi = li + 1; scanLi < lineCount; scanLi++) {
                        const scanText  = lineTextCache[scanLi];
                        const scanQuote = scanText.indexOf('"');
                        if (scanQuote !== -1) {
                            const group = extractSqlGroup(document, scanLi, scanQuote);
                            if (group !== null) {
                                stitchedValue = group.stitched;
                                for (const seg of group.segments) { processedAssignLines.add(seg.lineIndex); }
                            } else {
                                const strPat = /"((?:[^"]|"")*)"/g;
                                let sm: RegExpExecArray | null;
                                const lits: string[] = [];
                                while ((sm = strPat.exec(scanText)) !== null) {
                                    lits.push(sm[1].replace(/""/g, '"'));
                                }
                                stitchedValue = lits.join(' ');
                            }
                            break;
                        }
                        // Stop if this continuation line doesn't continue further
                        if (!scanText.trimEnd().endsWith('_')) { break; }
                    }
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
            for (const [varName, assignments] of assignmentMap) {
                if (sqlVars.has(varName)) { continue; }
                const selfAssigns    = assignments.filter(a =>  a.isSelfAppend);
                if (selfAssigns.length === 0) { continue; }
                const nonSelfAssigns = assignments.filter(a => !a.isSelfAppend);
                // Guard (b): must have at least one non-self-append as the SQL seed.
                if (nonSelfAssigns.length === 0) { continue; }
                // Guard (c): every non-self-append must look like SQL.
                if (!nonSelfAssigns.every(a => isSqlOrFragment(a.stitchedValue) || isSqlClauseFragment(a.stitchedValue))) { continue; }
                const allAppends = [...selfAssigns, ...nonSelfAssigns];
                // Guard (d): at least one append must contain SQL content.
                if (!allAppends.some(a => isSqlOrFragment(a.stitchedValue) || isSqlClauseFragment(a.stitchedValue))) { continue; }
                sqlVars.add(varName);
                changed = true;
            }
        }

        // ── Sub-pass 2b: SQL expression fragment promotion ───────────────────────
        // Variables like anpQRAssort = "LTRIM(RTRIM(SUBSTRING(...)))" hold pure
        // SQL expressions that get embedded into confirmed SQL variables via gaps:
        //   anpSub = "(SELECT " & anpQRAssort & " AS Assortment, " & _
        //            anpQRMix & ...
        // anpQRAssort appears on a CONTINUATION line with no '=', so a simple
        // per-line assignPattern check misses it entirely.
        //
        // Fix: scan continuation groups as a unit. When a line opens a SQL var
        // assignment, walk ALL its continuation lines and check their non-string
        // gaps for candidate variables.
        const sqlExprPromoted = new Set<string>(); // vars promoted via SQL expression fragment detection
        {
            // Step A: collect candidates whose stitched value is a SQL expression.
            const sqlExprCandidates = new Set<string>();
            for (const [varName, assignments] of assignmentMap) {
                if (sqlVars.has(varName)) { continue; }
                for (const a of assignments) {
                    if (!a.isSelfAppend && isSqlExpression(a.stitchedValue)) {
                        sqlExprCandidates.add(varName);
                        break;
                    }
                }
            }

            if (sqlExprCandidates.size > 0) {
                const candidatePattern = new RegExp(
                    '\\b(' + [...sqlExprCandidates]
                        .map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                        .join('|') + ')\\b',
                    'gi'
                );

                // Step B: walk every line. When we find an assignment into a sqlVar,
                // follow the full continuation group and check ALL gap text for candidates.
                let li = 0;
                while (li < lineCount) {
                    const lineText   = lineTextCache[li];
                    const lineOffset = lineOffsetCache[li];
                    if (!inAsp(lineOffset + Math.floor(lineText.length / 2))) { li++; continue; }

                    const stripped = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                    const cpIdx    = stripped.indexOf("'");
                    const active   = cpIdx !== -1 ? stripped.substring(0, cpIdx) : stripped;

                    const am = assignPattern.exec(active);
                    if (!am || !sqlVars.has(am[1].toLowerCase())) { li++; continue; }

                    // Found a SQL var assignment — scan this line and all its continuations.
                    let scanLi = li;
                    while (scanLi < lineCount) {
                        const scanText    = lineTextCache[scanLi];
                        const scanStripped = scanText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                        const scanCp       = scanStripped.indexOf("'");
                        const scanActive   = scanCp !== -1 ? scanStripped.substring(0, scanCp) : scanStripped;

                        candidatePattern.lastIndex = 0;
                        let m2: RegExpExecArray | null;
                        while ((m2 = candidatePattern.exec(scanActive)) !== null) {
                            sqlVars.add(m2[1].toLowerCase());
                            sqlExprPromoted.add(m2[1].toLowerCase());
                        }

                        // Continue only if this line ends with & _ (line continuation)
                        const trimmedEnd = scanActive.trimEnd();
                        if (!trimmedEnd.endsWith('_')) { break; }
                        const beforeUnderscore = trimmedEnd.slice(0, -1).trimEnd();
                        if (!beforeUnderscore.endsWith('&') && !beforeUnderscore.endsWith('=')) { break; }
                        scanLi++;
                    }
                    li = scanLi + 1;
                }
            }
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
            if (fn.filePath !== docPath)             { continue; }
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

                // Skip VBScript comment lines entirely — don't analyse them for return values
                const trimmedForComment846 = lineText.trimStart();
                if (trimmedForComment846.startsWith("'") || /^rem\s/i.test(trimmedForComment846)) { continue; }

                // Strip string literals and comments for structural matching
                let stripped = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                const cpIdx  = stripped.indexOf("'");
                if (cpIdx !== -1) { stripped = stripped.substring(0, cpIdx); }

                const rm = returnPattern.exec(stripped);
                if (!rm) { continue; }

                // Found a return assignment — check if it contains a string literal.
                // When quoteCol === -1 the return line uses a line continuation (_ at end)
                // with the actual string on the next line e.g. BuildBOMCTE = _ / "WITH BOM..."
                // Walk continuation lines to find the first quote, same as Pass A does.
                let quoteCol = lineText.indexOf('"');
                let quoteLi  = li;

                if (quoteCol === -1) {
                    const rhsTrimmed = lineText.trimEnd();
                    if (rhsTrimmed.endsWith('_') && rhsTrimmed.slice(0, -1).trimEnd().endsWith('=')) {
                        for (let scanLi = li + 1; scanLi <= fn.endLine; scanLi++) {
                            const scanText  = lineTextCache[scanLi];
                            const scanQuote = scanText.indexOf('"');
                            if (scanQuote !== -1) {
                                quoteCol = scanQuote;
                                quoteLi  = scanLi;
                                break;
                            }
                            if (!scanText.trimEnd().endsWith('_')) { break; }
                        }
                    }
                    if (quoteCol === -1) {
                        foundStringReturn = true; // pessimistically treat as string-capable
                        continue;
                    }
                }

                foundStringReturn = true;

                // Try to stitch multi-line string the same way assignmentMap does
                const group = extractSqlGroup(document, quoteLi, quoteCol);
                let stitched = '';
                if (group !== null) {
                    stitched = group.stitched;
                } else {
                    const quoteLine = lineTextCache[quoteLi];
                    const strPat = /"((?:[^"]|"")*)"/g;
                    let sm: RegExpExecArray | null;
                    const lits: string[] = [];
                    while ((sm = strPat.exec(quoteLine)) !== null) {
                        lits.push(sm[1].replace(/""/g, '"'));
                    }
                    stitched = lits.join(' ');
                }

                if (stitched && (isSqlOrFragment(stitched) || isSqlClauseFragment(stitched))) {
                    isSqlReturn = true;
                    break;
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

            const escapedV3 = varName3.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const selfRefRe  = new RegExp('^\\b' + escapedV3 + '\\b', 'i');
            const varNameRe  = new RegExp('\\b' + escapedV3 + '\\b', 'i');

            // Skip variables promoted via SQL expression fragment — their assignments
            // are intentionally SQL expressions (SUBSTRING, CHARINDEX, etc.) that don't
            // pass isSql(), so the "non-SQL assignment" warning is a false positive.
            if (sqlExprPromoted.has(varName3)) { continue; }

            for (const a of assignments) {
                if (a.isSelfAppend || isSqlOrFragment(a.stitchedValue) || isSqlClauseFragment(a.stitchedValue) || isSqlExpression(a.stitchedValue)) { continue; }

                for (let li = 0; li < lineCount; li++) {
                    const lineText   = lineTextCache[li];
                    const lineOffset = lineOffsetCache[li];
                    const midOffset  = lineOffset + Math.floor(lineText.length / 2);
                    if (!inAsp(midOffset)) { continue; }

                    const trimmedForComment918 = lineText.trimStart();
                    if (trimmedForComment918.startsWith("'") || /^rem\s/i.test(trimmedForComment918)) { continue; }

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
            const lineOffset = lineOffsetCache[li];
            const midOffset  = lineOffset + Math.floor(lineText.length / 2);
            if (!inAsp(midOffset)) { continue; }

            const trimmedForComment988 = lineText.trimStart();
            if (trimmedForComment988.startsWith("'") || /^rem\s/i.test(trimmedForComment988)) { continue; }

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
                // Look left: skip whitespace, then expect either:
                //   (a) & followed by § — direct string flanking: "sql" & var & "sql"
                //   (b) ( or , — identifier is a function argument: Replace(var, ...) or f(x, var)
                let l = startInRhs - 1;
                while (l >= 0 && (rhsText[l] === ' ' || rhsText[l] === '\t')) { l--; }
                if (l < 0) { return false; }

                let leftIsStr: boolean;
                if (rhsText[l] === '(' || rhsText[l] === ',') {
                    // Inside a function call — definitely a value argument
                    leftIsStr = true;
                } else if (rhsText[l] === '&') {
                    l--;
                    while (l >= 0 && (rhsText[l] === ' ' || rhsText[l] === '\t')) { l--; }
                    leftIsStr = l >= 0 && rhsText[l] === '§';
                } else {
                    return false;
                }

                // Look right: skip the identifier's own call parens if any, then expect either:
                //   (a) & followed by § — direct string flanking
                //   (b) ) or , — identifier is inside a function call
                let r = endInRhs;
                if (r < rhsText.length && rhsText[r] === '(') {
                    let depth = 1; r++;
                    while (r < rhsText.length && depth > 0) {
                        if (rhsText[r] === '(') { depth++; }
                        else if (rhsText[r] === ')') { depth--; }
                        r++;
                    }
                }
                while (r < rhsText.length && (rhsText[r] === ' ' || rhsText[r] === '\t')) { r++; }
                if (r >= rhsText.length) { return false; }

                let rightIsStr: boolean;
                if (rhsText[r] === ')' || rhsText[r] === ',') {
                    rightIsStr = true;
                } else if (rhsText[r] === '&') {
                    r++;
                    while (r < rhsText.length && (rhsText[r] === ' ' || rhsText[r] === '\t')) { r++; }
                    rightIsStr = r < rhsText.length && rhsText[r] === '§';
                } else {
                    return false;
                }

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
                if (VBSCRIPT_KEYWORDS_SET.has(wordKey)) { continue; }

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
            const len = colEnd - colStart;
            const omLine = new Int32Array(len).fill(li);
            const omCol  = Int32Array.from({ length: len }, (_, i) => colStart + i);
            const group: SqlStringGroup = {
                segments: [{ lineIndex: li, lineText, colStart, colEnd }],
                stitched: lineText.substring(colStart, colEnd),
                omLine, omCol,
            };
            emitSqlTokensForGroup(builder, group);
            if (!sqlStringLines.has(li)) { sqlStringLines.set(li, []); }
            sqlStringLines.get(li)!.push([colStart, colEnd]);
        }

        // Single combined regex for all SQL variable names + SQL-returning function names.
        // The pre-pass uses it to detect lines that write into a confirmed SQL variable.
        // Single combined regex replaces N separate regexes tested per line.
        const sqlVarNames = [
            ...[...sqlVars].map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
            ...[...sqlFuncs].map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        ];
        const sqlVarPattern: RegExp | null = sqlVarNames.length > 0
            ? new RegExp('^\\s*(?:' + sqlVarNames.join('|') + ')\\s*(?:=|&)', 'i')
            : null;

        for (let li = 0; li < lineCount; li++) {
            if (processedSqlLines.has(li)) { continue; }

            const lineText   = lineTextCache[li];
            const lineOffset = lineOffsetCache[li];
            const midOffset  = lineOffset + Math.floor(lineText.length / 2);
            if (!inAsp(midOffset)) { continue; }

            const trimmedForComment1173 = lineText.trimStart();
            if (trimmedForComment1173.startsWith("'") || /^rem\s/i.test(trimmedForComment1173)) { continue; }

            let lineIsSqlAppend = false;
            if (sqlVarPattern !== null) {
                let stripped2 = lineText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                const cp2 = stripped2.indexOf("'");
                if (cp2 !== -1) { stripped2 = stripped2.substring(0, cp2); }
                lineIsSqlAppend = sqlVarPattern.test(stripped2);
                if (!lineIsSqlAppend) {
                    let checkLi = li - 1;
                    while (checkLi >= 0) {
                        const prevText = lineTextCache[checkLi];
                        const trimmed = prevText.trimEnd();
                        if (!trimmed.endsWith('_')) { break; }
                        const beforeUnderscore = trimmed.slice(0, -1).trimEnd();
                        if (!beforeUnderscore.endsWith('&') && !beforeUnderscore.endsWith('=')) { break; }
                        let prevStripped = prevText.replace(/"(?:[^"]|"")*"/g, m => ' '.repeat(m.length));
                        const prevCp = prevStripped.indexOf("'");
                        if (prevCp !== -1) { prevStripped = prevStripped.substring(0, prevCp); }
                        if (sqlVarPattern.test(prevStripped)) { lineIsSqlAppend = true; break; }
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

        return builder.build();
    }
}