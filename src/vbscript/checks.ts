/**
 * checks.ts
 *
 * Problems in a page's VBScript that the parser and binder can see, each one
 * something the VBScript engine itself would stop at, or code that does
 * nothing (the rules were checked against cscript.exe):
 *
 *   name-redefined   a name declared twice where VBScript forbids it; the
 *                    page does not compile
 *   undeclared       a name nothing declares, on a page with Option Explicit;
 *                    VBScript stops there with "Variable is undefined"
 *   wrong-arguments  a Sub or Function of the page called with too many or
 *                    too few arguments; VBScript stops there with "Wrong
 *                    number of arguments"
 *   unused           a variable or constant declared in a procedure and never
 *                    used
 *   unreachable      statements after an Exit in the same block, which never
 *                    run (VBScript has no GoTo that could reach them)
 *
 * Only what is written in the page itself is reported, not in its includes;
 * each include is checked when it is open.
 *
 * Imports no vscode APIs, so the tests can run it directly.
 */

import type * as A from './ast';
import type { Declaration, Reference, Scope } from './binder';
import { statementExpressions, walkExpression } from './expressions';
import type { BoundPage } from './references';
import { walkStatements } from './symbols';

export type CheckCode = 'name-redefined' | 'undeclared' | 'wrong-arguments' | 'unused' | 'unreachable';

export interface Check {
    code: CheckCode;
    start: number;
    end: number;
    message: string;
}

/**
 * The ids of the `<object runat="server" id="…">` tags in a page or in
 * global.asa: each makes an object every page can use without declaring it.
 */
export function objectTagIds(text: string): string[] {
    const ids: string[] = [];
    for (const tag of text.match(/<object\b[^>]*>/gi) ?? []) {
        if (!/\brunat\s*=\s*["']?server\b/i.test(tag)) { continue; }
        const id = /\bid\s*=\s*["']?([A-Za-z_]\w*)/i.exec(tag);
        if (id) { ids.push(id[1].toLowerCase()); }
    }
    return ids;
}

/**
 * The checks for the page `path` in its bound script scope. `builtins` holds
 * the names a page may use without declaring them, lower-cased: the ASP
 * objects, VBScript's functions and constants, and objects global.asa
 * declares.
 */
export function checkPage(bound: BoundPage, path: string, builtins: ReadonlySet<string>): Check[] {
    const page = bound.pages.get(path.toLowerCase());
    if (!page) { return []; }
    const { binding } = bound;
    const inPage = (file: string) => file.toLowerCase() === path.toLowerCase();
    const checks: Check[] = [];
    const add = (code: CheckCode, span: A.Span, message: string) => checks.push({ code, start: span.start, end: span.end, message });

    // ── A name declared twice ────────────────────────────────────────────
    for (const d of binding.diagnostics) {
        if (inPage(d.file)) { add('name-redefined', d, `Name redefined: this name is already declared, so VBScript will not compile the page.`); }
    }

    const refsHere = binding.references.filter(r => inPage(r.file));
    const refAt = new Map<number, Reference>(refsHere.map(r => [r.span.start, r]));
    const server = binding.scopes[0];
    const rootOf = (scope: Scope) => { let s = scope; while (s.parent) { s = s.parent; } return s; };

    // ── A name nothing declares, under Option Explicit ───────────────────
    // Not when an include could not be read: it may declare the name.
    if (binding.optionExplicit && !bound.problems.some(p => p.kind === 'missing')) {
        const objects = new Set([...bound.pages.values()].flatMap(p => objectTagIds(p.text)));
        for (const r of refsHere) {
            if (r.declaration || r.target || rootOf(r.scope) !== server) { continue; }
            // `Me.x` names a member, which is not a variable to declare.
            if (page.text[r.span.start - 1] === '.') { continue; }
            if (builtins.has(r.name) || objects.has(r.name)) { continue; }
            add('undeclared', r.span,
                `'${page.text.slice(r.span.start, r.span.end)}' is not declared. The page has Option Explicit, ` +
                `so VBScript stops here with "Variable is undefined". Declare it with Dim.`);
        }
    }

    // ── Procedures called with the wrong number of arguments ─────────────
    const procedureOf = (name: A.Name): A.ProcedureStmt | null => {
        const decl: Declaration | null | undefined = refAt.get(name.start)?.target;
        const node = decl?.node;
        return node?.kind === 'Procedure' && node.procKind !== 'property' ? node : null;
    };
    const checkCall = (name: A.Name, given: number) => {
        const proc = procedureOf(name);
        if (!proc || proc.params.length === given) { return; }
        const wanted = proc.params.length;
        add('wrong-arguments', name,
            `'${proc.name.text}' takes ${wanted} argument${wanted === 1 ? '' : 's'}, but ${given === 0 ? 'none are' : given === 1 ? '1 is' : `${given} are`} given here. ` +
            `VBScript stops here with "Wrong number of arguments".`);
    };

    for (const program of page.programs) {
        walkStatements(program.body, (stmt, procedure) => {
            const callees = new Set<A.Expr>();
            if (stmt.kind === 'CallStmt' && stmt.callee.kind === 'Ident') {
                checkCall(stmt.callee.name, stmt.args.length);
                callees.add(stmt.callee);
            }
            // A Function's own name, read or written inside it, is its return value.
            const ownName = (e: A.IdentExpr) => procedure !== null && procedureOf(e.name) === procedure;
            if (stmt.kind === 'Assign') { callees.add(stmt.target); }
            for (const expr of statementExpressions(stmt)) {
                walkExpression(expr, e => {
                    if (e.kind === 'Call' && e.callee.kind === 'Ident') {
                        checkCall(e.callee.name, e.args.length);
                        callees.add(e.callee);
                    } else if (e.kind === 'Ident' && !callees.has(e) && !ownName(e)) {
                        checkCall(e.name, 0);
                    }
                });
            }
        });
    }

    // ── Variables and constants declared in a procedure and never used ───
    const used = new Set(binding.references.filter(r => !r.declaration && r.target).map(r => r.target!));
    for (const d of binding.declarations) {
        if (!inPage(d.file) || d.implicit || d.scope.kind !== 'procedure' || used.has(d)) { continue; }
        if (d.kind !== 'variable' && d.kind !== 'constant') { continue; }
        add('unused', d.span, `'${d.text}' is declared but never used.`);
    }

    // ── Statements after an Exit ──────────────────────────────────────────
    const visitBody = (body: A.Stmt[]) => {
        const exit = body.findIndex(s => s.kind === 'Exit');
        const after = exit >= 0 ? body.slice(exit + 1) : [];
        if (after.length > 0) {
            const word = (body[exit] as A.ExitStmt).target;
            add('unreachable', { start: after[0].start, end: after[after.length - 1].end },
                `Unreachable code: it comes after Exit ${word[0].toUpperCase()}${word.slice(1)}, so it never runs.`);
        }
        for (const s of body.slice(0, exit >= 0 ? exit : body.length)) {
            for (const inner of bodiesOf(s)) { visitBody(inner); }
        }
    };
    for (const program of page.programs) { visitBody(program.body); }

    return checks.sort((a, b) => a.start - b.start);
}

function bodiesOf(s: A.Stmt): A.Stmt[][] {
    switch (s.kind) {
        case 'If':        return s.branches.map(b => b.body);
        case 'Select':    return s.cases.map(c => c.body);
        case 'For':
        case 'ForEach':
        case 'Do':
        case 'While':
        case 'With':
        case 'Procedure': return [s.body];
        case 'Class':     return [s.members];
        default:          return [];
    }
}
