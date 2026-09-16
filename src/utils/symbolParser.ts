/**
 * symbolParser.ts
 *
 * The VBScript symbol parser: text in, declared symbols out.
 *
 * Deliberately imports NO vscode APIs. That is the whole point of it living
 * here rather than in includeProvider.ts — a worker thread has no access to
 * the vscode module, so anything that wants to parse ASP off the UI thread
 * needs a parser it can actually import. Keeping exactly one implementation
 * is what stops the two from drifting apart: every edge case handled below
 * (embedded <script> zones, line continuations, commented-out CreateObject
 * calls) is one a second copy would have to rediscover the hard way.
 *
 * Its own dependencies are pure for the same reason: zoneUtils has no imports
 * at all, and comObjects is a lookup table.
 */

import { COM_METHOD_RETURN_TYPES } from '../constants/comObjects';
import { createZoneResolver } from '../utils/zoneUtils';


// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FileSymbols {
    // `implicit` marks a name that was never explicitly declared - a bare
    // assignment (no Option Explicit) or a For Each loop variable. VBScript
    // does NOT create a new local for those: inside a procedure they resolve to
    // the module-level variable of that name when one exists. Only an explicit
    // Dim/Const shadows it, so anything reasoning about scope must tell them
    // apart (see shadowingBodies in aspRenameProvider).
    variables:    { name: string; line: number; filePath: string; implicit?: boolean }[];
    constants:    { name: string; value: string; line: number; filePath: string }[];
    functions:    {
        name: string;
        kind: 'Function' | 'Sub' | 'Property';
        params: string;
        paramNames: string[];
        line: number;
        endLine: number;
        filePath: string;
    }[];
    comVariables: { name: string; progId: string; line: number; filePath: string }[];
    classes:      { name: string; line: number; endLine: number; filePath: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol extraction
// Parses a block of ASP/VBScript text and returns all declared symbols
// (variables, constants, functions/subs, COM objects) tagged with their
// source file path and line number.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drops a trailing `'` comment, respecting string literals so an apostrophe
 * inside "…" (or a doubled "" escape) is not mistaken for the comment marker.
 */
function stripVbTrailingComment(code: string): string {
    let inStr = false;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '"') {
            if (inStr && code[i + 1] === '"') { i++; continue; } // "" escaped quote
            inStr = !inStr;
        } else if (!inStr && ch === "'") {
            return code.slice(0, i);
        }
    }
    return code;
}

/**
 * The VBScript code spans of one physical line: the text inside each `<% … %>`,
 * or the whole line when it has no `<%` (we are then inside a multi-line block).
 *
 * Used by passes that must run on the raw line — the CreateObject scan needs the
 * ProgID string intact — so the HTML around the script cannot contribute matches
 * and an apostrophe in HTML text cannot look like a VBScript comment.
 */
function vbCodeSpans(line: string): string[] {
    if (line.indexOf('<%') === -1) { return [line]; }

    const spans: string[] = [];
    let i = 0;
    while (i < line.length) {
        const open = line.indexOf('<%', i);
        if (open === -1) { break; }

        let bodyStart = open + 2;
        if (line[bodyStart] === '=' || line[bodyStart] === '@') { bodyStart++; }

        const close = line.indexOf('%>', bodyStart);
        spans.push(line.slice(bodyStart, close === -1 ? line.length : close));
        i = close === -1 ? line.length : close + 2;
    }
    return spans;
}

/**
 * Splits a line into its `:`-separated VBScript statements, ignoring a colon
 * inside a string literal so `Const URL = "http://x"` stays one statement.
 *
 * Every declaration matcher is anchored at the start of a statement, so without
 * this a one-liner like `Dim x : x = 1` — everyday ASP — matched nothing at all
 * and the variable was dropped from completion, hover, go-to-definition and rename.
 */
function splitStatements(code: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let inStr = false;

    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '"') {
            if (inStr && code[i + 1] === '"') { i++; continue; } // "" escaped quote
            inStr = !inStr;
        } else if (!inStr && ch === ':') {
            parts.push(code.slice(start, i));
            start = i + 1;
        }
    }

    parts.push(code.slice(start));
    return parts;
}

/**
 * True when a physical line ends with a VBScript line continuation (`_` preceded
 * by whitespace). Strings and a trailing comment are removed first so a `_` that
 * is merely the last character of a literal does not count.
 */
function endsWithLineContinuation(line: string): boolean {
    const bare = stripVbTrailingComment(line.replace(/"(?:[^"]|"")*"/g, ''));
    return /(?:^|\s)_\s*$/.test(bare);
}

/**
 * Joins physical lines that end with `_` into the logical line they form.
 *
 * The result has the SAME length as the input: the joined text replaces the
 * chain's first line and every continued line becomes empty. That keeps every
 * index equal to its physical line number, so declarations still report the line
 * they start on and the byte offsets used for zone probing stay valid — while the
 * declaration matchers, which are all anchored at the start of a statement, get
 * to see the whole declaration instead of a fragment.
 */
function joinContinuedLines(lines: string[]): string[] {
    const joined: string[] = new Array(lines.length).fill('');

    let i = 0;
    while (i < lines.length) {
        const start = i;
        let text = lines[i];

        while (endsWithLineContinuation(text) && i + 1 < lines.length) {
            text = text.replace(/\s*_\s*$/, ' ') + lines[i + 1].trim();
            i++;
        }

        joined[start] = text;
        i++;
    }

    return joined;
}

export function extractSymbols(text: string, filePath: string): FileSymbols {
    const result: FileSymbols = {
        variables:    [],
        constants:    [],
        functions:    [],
        comVariables: [],
        classes:      [],
    };

    // Strip HTML comments so <!--METADATA ... --> blocks don't produce false symbols.
    // Non-newline characters are replaced with spaces to preserve line numbers.
    const strippedText = text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
    const physicalLines = strippedText.split('\n');

    // Byte offset of each line's start, so a declaration can be located precisely
    // enough to ask getZone which embedded language it sits in (see the zone guard
    // in the loop below). Computed from the PHYSICAL lines so the offsets stay
    // valid after continuation joining, which does not change line count.
    const lineOffsets: number[] = [];
    {
        let acc = 0;
        for (const l of physicalLines) { lineOffsets.push(acc); acc += l.length + 1; }
    }

    // Parse logical lines: a declaration split over a trailing `_` must be seen
    // whole, or its parameter list / trailing names are lost and the `_` itself
    // is captured as a variable.
    const lines = joinContinuedLines(physicalLines);

    // Detect Option Explicit anywhere in the file (outside of string literals).
    // When present, VBScript requires all variables to be declared with Dim/Const,
    // so implicit assignment tracking would only add noise — loop counters, temp
    // vars, and typos would all surface as false symbol suggestions.
    const hasOptionExplicit = /^\s*Option\s+Explicit\b/im.test(strippedText);

    // One linear scan up front, then every per-line zone question below is a
    // binary search. Asking getZone per line instead re-scanned the document
    // from offset 0 each time, which made parsing a large embedded <script>
    // block quadratic — seconds of the extension host, per keystroke.
    const zones = createZoneResolver(strippedText);

    lines.forEach((line, lineIndex) => {
        // Skip full-line VBScript comments
        if (/^\s*'/.test(line)) return;

        // Ignore declarations that live inside a client-side <script> (JS) or a
        // <style> (CSS) block — a JS `function foo()` or `x = 1` must never surface
        // as a VBScript symbol. Zones 'asp' and 'html' are kept: 'html' covers
        // pure-code include files that have no <% %> wrappers at all.
        const aspOpen  = line.indexOf('<%');
        const probeCol = aspOpen !== -1 ? aspOpen + 2 : (line.length - line.trimStart().length);
        const zone     = zones.zoneAt(lineOffsets[lineIndex] + probeCol);
        if (zone === 'js' || zone === 'css') { return; }

        // Inline ASP blocks: strip a leading <% / <%= and a trailing %> so a
        // one-line declaration like `<% Dim x %>` is parsed exactly like its
        // multi-line form. Lines that merely contain a small <%…%> in the middle
        // are left untouched (they are not declarations anyway).
        const codeLine = line.replace(/^(\s*)<%=?/, '$1').replace(/\s*%>\s*$/, '');

        // Strip string literals and inline comments so SQL / string content
        // inside quotes is never mistaken for code.
        const lineNoComment = codeLine.replace(
            /(['"])(?:(?!\1).)*\1|'.*$/g,
            (m) => m.startsWith("'") ? '' : (m[0] + m[0])
        );

        // Every matcher below is anchored at the start of a statement, so run them
        // per `:`-separated statement — `Dim x : x = 1` is two declarations, not one
        // unparseable line.
        for (const statement of splitStatements(lineNoComment)) {
            // Dim / ReDim / Public / Private
            // Guard: `Public`/`Private` also prefix Function/Sub/Property/Class/Const
            // declarations — those are handled below, not as variables. Without this,
            // `Public Sub Foo` would be captured as a bogus variable named "Sub Foo".
            // Capture the whole declarator list (`.+?`, not `[\w,\s]+?`) so an array
            // bound like `arr(10)` doesn't abort the match and drop every name on the
            // line. Each declarator then has its `(…)` bounds and a leading `Preserve`
            // stripped, and only real identifiers are kept.
            const dimMatch = statement.match(/^\s*(?:Dim|ReDim|Public|Private)\s+(.+?)\s*(?:'|$)/i);
            if (dimMatch && !/^(?:Function|Sub|Property|Class|Const|Default|Static)\b/i.test(dimMatch[1].trim())) {
                dimMatch[1].split(',')
                    .map((s: string) => s.trim().replace(/^Preserve\s+/i, '').replace(/\(.*$/, '').trim())
                    // A lone `_` is a line-continuation marker, never an identifier —
                    // it only survives here if the chain could not be joined.
                    .filter((name: string) => name !== '_' && /^[A-Za-z_]\w*$/.test(name))
                    .forEach((name: string) => {
                        result.variables.push({ name, line: lineIndex, filePath });
                    });
            }

            // For Each loop variable  e.g.  For Each item In collection
            const forEachMatch = statement.match(/^\s*For\s+Each\s+(\w+)\s+In\b/i);
            if (forEachMatch) {
                const name = forEachMatch[1];
                if (!result.variables.some(v => v.name.toLowerCase() === name.toLowerCase())) {
                    result.variables.push({ name, line: lineIndex, filePath, implicit: true });
                }
            }

            // Implicit assignment (undeclared variables, no Option Explicit)
            // Skipped entirely when Option Explicit is present — in that mode every
            // real variable must be Dim'd, so implicit assignments are either already
            // captured above or are typos/loop counters we don't want in suggestions.
            if (!hasOptionExplicit) {
                const implicitMatch = statement.match(/^\s*([a-zA-Z_]\w*)\s*=/i);
                if (implicitMatch) {
                    const name = implicitMatch[1];
                    const nameLower = name.toLowerCase();
                    const skipWords = new Set([
                        'dim','redim','set','const','if','for','while','do',
                        'function','sub','class','select','with','on','option',
                    ]);
                    if (!skipWords.has(nameLower) && !result.variables.some(v => v.name.toLowerCase() === nameLower)) {
                        result.variables.push({ name, line: lineIndex, filePath, implicit: true });
                    }
                }
            }

            // Function / Sub (parentheses optional in VBScript)
            const funcMatch = statement.match(/^\s*(?:Public\s+|Private\s+)?(Function|Sub)\s+(\w+)\s*(?:\(([^)]*)\))?/i);
            if (funcMatch) {
                const rawParams  = funcMatch[3] ? funcMatch[3].trim() : '';
                const paramNames = rawParams.length > 0
                    ? rawParams.split(',').map((p: string) =>
                        p.trim().replace(/^(?:ByVal|ByRef)\s+/i, '').replace(/\(\)$/, '').trim()
                      ).filter(Boolean)
                    : [];
                result.functions.push({
                    name:       funcMatch[2],
                    kind:       funcMatch[1] as 'Function' | 'Sub',
                    params:     rawParams,
                    paramNames,
                    line:       lineIndex,
                    endLine:    -1,
                    filePath,
                });
            }

            // Property Get / Let / Set (a class member; treated like a callable so it
            // surfaces in the outline, completion, hover, and go-to-definition).
            const propMatch = statement.match(
                /^\s*(?:Public\s+|Private\s+|Default\s+)*Property\s+(?:Get|Let|Set)\s+(\w+)\s*(?:\(([^)]*)\))?/i,
            );
            if (propMatch) {
                const rawParams  = propMatch[2] ? propMatch[2].trim() : '';
                const paramNames = rawParams.length > 0
                    ? rawParams.split(',').map((p: string) =>
                        p.trim().replace(/^(?:ByVal|ByRef)\s+/i, '').replace(/\(\)$/, '').trim()
                      ).filter(Boolean)
                    : [];
                result.functions.push({
                    name:       propMatch[1],
                    kind:       'Property',
                    params:     rawParams,
                    paramNames,
                    line:       lineIndex,
                    endLine:    -1,
                    filePath,
                });
            }

            // Class declaration
            const classMatch = statement.match(/^\s*(?:Public\s+|Private\s+)?Class\s+(\w+)/i);
            if (classMatch) {
                result.classes.push({
                    name:    classMatch[1],
                    line:    lineIndex,
                    endLine: -1,
                    filePath,
                });
            }
        }

        // Const — run on the (inline-stripped) line so string values are preserved.
        // Strip only a trailing comment (but not string contents). splitStatements
        // keeps a colon inside the value intact, so `Const URL = "http://x"` is one
        // statement and its value is not truncated.
        const lineForConst = codeLine.replace(/'(?:[^"']|"[^"]*")*$/, '').trimEnd();
        for (const statement of splitStatements(lineForConst)) {
            const constMatch = statement.match(/^\s*(?:Public\s+|Private\s+)?Const\s+(\w+)\s*=\s*(.+?)\s*$/i);
            if (constMatch) {
                result.constants.push({
                    name:  constMatch[1],
                    value: constMatch[2].trim(),
                    line:  lineIndex,
                    filePath,
                });
            }
        }

        // Set x = [Server.]CreateObject("...") — must run on the raw code, not
        // lineNoComment, because the progId is inside a string literal. Run it per
        // VBScript span with the trailing comment removed, so a commented-out
        // CreateObject no longer registers a phantom typed COM variable and an
        // apostrophe in HTML sharing the line cannot truncate real code.
        for (const span of vbCodeSpans(line)) {
            const setMatch = stripVbTrailingComment(span)
                .match(/\bSet\s+(\w+)\s*=\s*(?:Server\.)?CreateObject\s*\(\s*["']([^"']+)["']\s*\)/i);
            if (setMatch) {
                result.comVariables.push({
                    name:   setMatch[1],
                    progId: setMatch[2].toLowerCase(),
                    line:   lineIndex,
                    filePath,
                });
            }
        }
    });

    // Second pass — pair each Function/Sub/Property/Class with its matching End
    // line. VBScript blocks nest (a Class contains members), so use a stack.
    const openStack: { setEnd: (end: number) => void }[] = [];
    lines.forEach((rawLine, lineIndex) => {
        const line = rawLine.replace(/^(\s*)<%=?/, '$1').replace(/\s*%>\s*$/, '');

        const openMatch = line.match(
            /^\s*(?:Public\s+|Private\s+|Default\s+|Static\s+)*(Function|Sub|Property|Class)\b/i,
        );
        if (openMatch) {
            if (openMatch[1].toLowerCase() === 'class') {
                const idx = result.classes.findIndex(c => c.line === lineIndex);
                if (idx !== -1) { openStack.push({ setEnd: (end) => { result.classes[idx].endLine = end; } }); }
            } else {
                const idx = result.functions.findIndex(f => f.line === lineIndex);
                if (idx !== -1) { openStack.push({ setEnd: (end) => { result.functions[idx].endLine = end; } }); }
            }
        }

        if (/^\s*End\s+(?:Function|Sub|Property|Class)\b/i.test(line) && openStack.length > 0) {
            openStack.pop()!.setEnd(lineIndex);
        }
    });

    // Third pass — infer COM types from chained method calls.
    // Matches: Set x = someVar.Method(...)
    // Looks up someVar's progId from already-collected comVariables, then checks
    // COM_METHOD_RETURN_TYPES to see if that method returns a typed COM object.
    const comVarIndex = new Map(result.comVariables.map(cv => [cv.name.toLowerCase(), cv.progId]));
    lines.forEach((line, lineIndex) => {
        if (/^\s*'/.test(line)) return;

        const chainMatch = line.match(/^\s*Set\s+(\w+)\s*=\s*(\w+)\.(\w+)\s*\(/i);
        if (!chainMatch) return;

        const [, assignTo, sourceVar, methodName] = chainMatch;

        // Skip if already tracked via CreateObject
        if (comVarIndex.has(assignTo.toLowerCase())) return;

        const sourceProgId = comVarIndex.get(sourceVar.toLowerCase());
        if (!sourceProgId) return;

        const returnProgId = COM_METHOD_RETURN_TYPES[`${sourceProgId}.${methodName.toLowerCase()}`];
        if (!returnProgId) return;

        result.comVariables.push({ name: assignTo, progId: returnProgId, line: lineIndex, filePath });
        comVarIndex.set(assignTo.toLowerCase(), returnProgId);
    });

    return result;
}
