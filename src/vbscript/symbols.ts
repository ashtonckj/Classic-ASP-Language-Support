/**
 * symbols.ts
 *
 * Reads the declared symbols of a page from its syntax trees, in the same
 * shape extractSymbols returns, so the two can be compared entry by entry and
 * the tree can later stand in for the line scanner behind the same API.
 *
 * Where extractSymbols makes a deliberate choice, this follows it:
 *   - A plain `x = …` records an implicit variable only when the page has no
 *     Option Explicit, and only for a name not seen before.
 *   - A For Each variable is implicit; a For counter is not recorded.
 *   - Every symbol reports the line its statement starts on.
 * What it does not copy is the line scanner's blind spots: a declaration after
 * `Then` on a one-line If, `<%= x = 1 %>` (a comparison, not an assignment),
 * HTML text that happens to look like code, and `F = …` inside Function F,
 * which sets the function's return value and declares nothing.
 */

import type * as A from './ast';
import { parseProgram } from './parser';
import { pagePrograms } from './pageSegments';
import type { FileSymbols } from './symbolParser';
import { COM_METHOD_RETURN_TYPES, normalizeProgId } from '../constants/comObjects';

export interface ParsedPage {
    text: string;
    programs: A.Program[];
    lineStarts: number[];
}

/** A `<object runat="server" id="…">` tag: an object the page's scripts use without declaring it. */
export interface ServerObject {
    /** As written. */
    id: string;
    /** As written, or null for an object given by classid. */
    progId: string | null;
    /** As written — Page, Session or Application — or null. */
    scope: string | null;
    /** The whole tag. */
    start: number;
    end: number;
}

/** Every `<object runat="server">` tag with an id, in page order. */
export function serverObjects(text: string): ServerObject[] {
    const objects: ServerObject[] = [];
    const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    for (const m of text.matchAll(/<object\b[^>]*>/gi)) {
        const tag = m[0];
        if (!/^server$/i.test(valueOf(attr(tag, 'runat')) ?? '')) { continue; }
        const id = valueOf(attr(tag, 'id'));
        if (!id || !/^[A-Za-z_]\w*$/.test(id)) { continue; }
        objects.push({ id, progId: valueOf(attr(tag, 'progid')), scope: valueOf(attr(tag, 'scope')), start: m.index, end: m.index + tag.length });
    }
    return objects;
}

function valueOf(match: RegExpExecArray | null): string | null {
    return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

export function parsePage(text: string): ParsedPage {
    const programs = pagePrograms(text).map(p => parseProgram(text, p.segments, p.server));
    const lineStarts = [0];
    // Lines split at `\n` only, as extractSymbols and VS Code's CRLF files count them.
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') { lineStarts.push(i + 1); }
    }
    return { text, programs, lineStarts };
}

/** 0-based line of an offset. */
export function lineAt(page: ParsedPage, offset: number): number {
    const starts = page.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
    }
    return lo;
}

/**
 * Calls `visit` on every statement, depth first, in source order, with the
 * procedure it sits in (null outside any Sub, Function or Property).
 */
export function walkStatements(
    stmts: A.Stmt[],
    visit: (s: A.Stmt, procedure: A.ProcedureStmt | null) => void,
    procedure: A.ProcedureStmt | null = null,
): void {
    for (const s of stmts) {
        visit(s, procedure);
        switch (s.kind) {
            case 'If':        for (const b of s.branches) { walkStatements(b.body, visit, procedure); } break;
            case 'Select':    for (const c of s.cases) { walkStatements(c.body, visit, procedure); } break;
            case 'For':
            case 'ForEach':
            case 'Do':
            case 'While':
            case 'With':      walkStatements(s.body, visit, procedure); break;
            case 'Procedure': walkStatements(s.body, visit, s); break;
            case 'Class':     walkStatements(s.members, visit, procedure); break;
        }
    }
}

/** The keyword a procedure is declared with, as it is written: `Sub`, `Function`, `Property`. */
export const PROCEDURE_WORD: Record<A.ProcedureStmt['procKind'], 'Function' | 'Sub' | 'Property'> = {
    function: 'Function', sub: 'Sub', property: 'Property',
};

/** Source text of a span, with `_` line continuations folded into one space. */
export function sourceOf(text: string, span: A.Span): string {
    return text.slice(span.start, span.end).replace(/[ \t]*_[ \t]*(?:\r\n|\r|\n)[ \t]*/g, ' ').trim();
}

function isCreateObject(callee: A.Expr): boolean {
    if (callee.kind === 'Ident') { return callee.name.name === 'createobject'; }
    return callee.kind === 'Member' && callee.name.name === 'createobject'
        && callee.object?.kind === 'Ident' && callee.object.name.name === 'server';
}

export function symbolsFromTree(text: string, filePath: string): FileSymbols {
    return symbolsOfPage(parsePage(text), filePath);
}

/** symbolsFromTree for a page already parsed. */
export function symbolsOfPage(page: ParsedPage, filePath: string): FileSymbols {
    const text = page.text;
    const result: FileSymbols = { variables: [], constants: [], functions: [], comVariables: [], classes: [] };

    const statements: A.Stmt[] = [];
    // The procedure each assignment sits in, for the function's own name.
    const owners = new Map<A.Stmt, A.ProcedureStmt | null>();
    for (const program of page.programs) {
        walkStatements(program.body, (s, procedure) => { statements.push(s); owners.set(s, procedure); });
    }
    statements.sort((a, b) => a.start - b.start);

    const line = (offset: number) => lineAt(page, offset);
    const hasOptionExplicit = statements.some(s => s.kind === 'OptionExplicit');
    // Lower-cased names already in result.variables: a Set, as a page can assign thousands of times.
    const variableNames = new Set<string>();
    const seen = (name: string) => variableNames.has(name);
    const addVariable = (variable: FileSymbols['variables'][number]) => {
        result.variables.push(variable);
        variableNames.add(variable.name.toLowerCase());
    };

    for (const s of statements) {
        switch (s.kind) {
            case 'Dim':
                for (const d of s.declarators) {
                    addVariable({ name: d.name.text, line: line(s.start), filePath });
                }
                break;

            case 'ForEach':
                if (s.variable.name && !seen(s.variable.name)) {
                    addVariable({ name: s.variable.text, line: line(s.start), filePath, implicit: true });
                }
                break;

            case 'Assign': {
                if (s.set || hasOptionExplicit || s.target.kind !== 'Ident' || seen(s.target.name.name)) { break; }
                const owner = owners.get(s);
                if (owner && owner.procKind !== 'sub' && owner.name.name === s.target.name.name) { break; }
                addVariable({ name: s.target.name.text, line: line(s.start), filePath, implicit: true });
                break;
            }

            case 'Const':
                for (const d of s.declarators) {
                    result.constants.push({ name: d.name.text, value: sourceOf(text, d.value), line: line(s.start), filePath });
                }
                break;

            case 'Procedure':
                result.functions.push({
                    name:       s.name.text,
                    kind:       PROCEDURE_WORD[s.procKind],
                    params:     s.paramList ? sourceOf(text, s.paramList) : '',
                    paramNames: s.params.map(p => p.name.text),
                    line:       line(s.start),
                    endLine:    s.endStatement ? line(s.endStatement.start) : -1,
                    filePath,
                });
                break;

            case 'Class':
                result.classes.push({
                    name:    s.name.text,
                    line:    line(s.start),
                    endLine: s.endStatement ? line(s.endStatement.start) : -1,
                    filePath,
                });
                break;
        }
    }

    // COM types: every `<object runat="server" progid="…">` and `Set x =
    // CreateObject("…")` first, then the variables assigned from a typed
    // object's method, `Set f = fso.GetFile(p)`, in order.
    for (const object of serverObjects(text)) {
        if (!object.progId) { continue; }
        result.comVariables.push({ name: object.id, progId: normalizeProgId(object.progId), line: line(object.start), filePath });
    }
    const sets = statements.filter((s): s is A.AssignStmt => s.kind === 'Assign' && s.set && s.target.kind === 'Ident');
    for (const s of sets) {
        const v = s.value;
        if (v.kind !== 'Call' || !isCreateObject(v.callee) || v.args.length !== 1) { continue; }
        const arg = v.args[0];
        if (arg?.kind !== 'Literal' || arg.type !== 'string') { continue; }
        result.comVariables.push({
            name:   (s.target as A.IdentExpr).name.text,
            progId: normalizeProgId(arg.raw.slice(1, -1).replace(/""/g, '"')),
            line:   line(s.start),
            filePath,
        });
    }

    const comVarIndex = new Map(result.comVariables.map(cv => [cv.name.toLowerCase(), cv.progId]));
    for (const s of sets) {
        const target = (s.target as A.IdentExpr).name;
        const v = s.value;
        if (comVarIndex.has(target.name)) { continue; }
        if (v.kind !== 'Call' || v.callee.kind !== 'Member' || v.callee.object?.kind !== 'Ident') { continue; }

        const sourceProgId = comVarIndex.get(v.callee.object.name.name);
        if (!sourceProgId) { continue; }
        const returnProgId = COM_METHOD_RETURN_TYPES[`${sourceProgId}.${v.callee.name.name}`];
        if (!returnProgId) { continue; }

        result.comVariables.push({ name: target.text, progId: returnProgId, line: line(s.start), filePath });
        comVarIndex.set(target.name, returnProgId);
    }

    return result;
}
