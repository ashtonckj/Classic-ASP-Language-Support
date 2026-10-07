/**
 * binder.ts
 *
 * Works out what every name in a script scope refers to. VBScript has three
 * kinds of scope, checked in this order when a name is looked up:
 *
 *   procedure  a Sub, Function or Property: its parameters and what it
 *              declares with Dim, ReDim or Const
 *   class      a Class: its fields, methods and properties, seen from inside
 *              its own procedures and through `Me.`
 *   script     the page and its includes (see scriptScope.ts): everything
 *              declared outside a procedure or class, and every procedure and
 *              class name
 *
 * Declarations are hoisted, as the VBScript engine hoists them: a Sub can be
 * called above the line that declares it. A name that is only ever assigned,
 * or used as a loop variable, is declared implicitly, unless Option Explicit
 * is on. Outside a procedure that makes a page-wide variable; inside one it
 * makes a local, unless the page already has a variable of that name, which
 * is then the one assigned. `F = …` inside Function F sets its return value.
 *
 * A client-side `<script language="vbscript">` runs in the browser, so each
 * one is a script scope of its own.
 *
 * A name in the part of a statement the parser skipped after an error is
 * still looked up, as a read in the procedure or class it sits in, so a
 * half-typed line does not drop out of a rename.
 *
 * Declaring a name twice where VBScript forbids it is reported as "Name
 * redefined", on the later declaration, with the engine's own rules (checked
 * against cscript.exe): the same Sub or Function twice in the script scope is
 * allowed, a Property Get and Let may share a name, and a Function's locals
 * may not reuse the Function's name, though a Sub's may.
 */

import type * as A from './ast';
import { childExpressions } from './expressions';
import type { ParsedPage } from './symbols';
import { orderKey, type ScopeFile, type ScriptScope } from './scriptScope';

export type DeclarationKind = 'variable' | 'constant' | 'parameter' | 'sub' | 'function' | 'property' | 'class';

export interface Declaration {
    /** Lowercase, without brackets. */
    name: string;
    /** As written. */
    text: string;
    kind: DeclarationKind;
    file: string;
    /** The name where it is declared. */
    span: A.Span;
    scope: Scope;
    /** Created by an assignment or a loop, not by Dim, ReDim, Const or a parameter list. */
    implicit: boolean;
    /** For a property: which accessor. */
    accessor?: 'get' | 'let' | 'set';
    /** For a procedure or class: the statement, whose body is `scopeOf` it. */
    node?: A.ProcedureStmt | A.ClassStmt;
}

export interface Scope {
    kind: 'script' | 'class' | 'procedure';
    parent: Scope | null;
    /** The procedure or class that opens it; null for a script scope. */
    node: A.ProcedureStmt | A.ClassStmt | null;
    declarations: Map<string, Declaration[]>;
}

/** One place a name is written: a declaration, or a use of one. */
export interface Reference {
    name: string;
    file: string;
    span: A.Span;
    scope: Scope;
    /** What it refers to; null for a name declared nowhere in the scope, such as Response. */
    target: Declaration | null;
    declaration: boolean;
}

/**
 * `obj.name`, or `.name` inside a With block: a member of some object.
 * Nothing says what class the object is, so it is not bound to a declaration.
 */
export interface MemberUse {
    name: string;
    file: string;
    span: A.Span;
    scope: Scope;
}

export interface BindingDiagnostic {
    file: string;
    start: number;
    end: number;
    message: string;
}

export interface Binding {
    /** The server script scope, then one per client-side script. */
    scopes: Scope[];
    declarations: Declaration[];
    references: Reference[];
    members: MemberUse[];
    diagnostics: BindingDiagnostic[];
    optionExplicit: boolean;
    /** The scope a procedure's or class's body opens. */
    scopeOf: Map<A.ProcedureStmt | A.ClassStmt, Scope>;
}

/** Binds a single page, for when its includes are not known or not wanted. */
export function bindPage(path: string, page: ParsedPage): Binding {
    const file: ScopeFile = { path, text: page.text, page, includes: [] };
    return bindScriptScope({ root: file, files: [file], chunks: [{ file, start: 0, end: page.text.length + 1 }], problems: [] });
}

export function bindScriptScope(scriptScope: ScriptScope): Binding {
    return new Binder(scriptScope).bind();
}

const PROCEDURE_KIND: Record<A.ProcedureStmt['procKind'], DeclarationKind> = {
    sub: 'sub', function: 'function', property: 'property',
};

class Binder {
    private readonly binding: Binding = {
        scopes: [], declarations: [], references: [], members: [], diagnostics: [], optionExplicit: false, scopeOf: new Map(),
    };

    /** The names each procedure has ReDim'd so far, in the declare pass. */
    private readonly redimmed = new Map<Scope, Set<string>>();

    constructor(private readonly scriptScope: ScriptScope) {}

    bind(): Binding {
        const script = this.newScope('script', null, null);

        // Statements in the order IIS reads them, across the page and its includes.
        const server: { file: ScopeFile; stmt: A.Stmt; key: number }[] = [];
        for (const file of this.scriptScope.files) {
            for (const program of file.page.programs) {
                if (!program.server) { continue; }
                for (const stmt of program.body) {
                    server.push({ file, stmt, key: orderKey(this.scriptScope, file, stmt.start) });
                    if (stmt.kind === 'OptionExplicit') { this.binding.optionExplicit = true; }
                }
            }
        }
        server.sort((a, b) => a.key - b.key);

        for (const { file, stmt } of server) { this.declare([stmt], script, file.path); }
        this.redimmed.clear();
        for (const { file, stmt } of server) { this.declareImplicitGlobals([stmt], script, file.path); }
        for (const { file, stmt } of server) { this.declareProcedureLocals([stmt], file.path); }
        for (const { file, stmt } of server) { this.resolve([stmt], script, file.path); }
        for (const file of this.scriptScope.files) {
            for (const program of file.page.programs) {
                if (program.server) { this.resolveSkipped(program, script, file.path); }
            }
        }

        // Each client-side script on its own.
        for (const file of this.scriptScope.files) {
            for (const program of file.page.programs) {
                if (program.server) { continue; }
                const own = this.newScope('script', null, null);
                this.declare(program.body, own, file.path);
                this.redimmed.clear();
                this.declareImplicitGlobals(program.body, own, file.path);
                this.declareProcedureLocals(program.body, file.path);
                this.resolve(program.body, own, file.path);
                this.resolveSkipped(program, own, file.path);
            }
        }
        return this.binding;
    }

    private newScope(kind: Scope['kind'], parent: Scope | null, node: Scope['node']): Scope {
        const scope: Scope = { kind, parent, node, declarations: new Map() };
        this.binding.scopes.push(scope);
        if (node) { this.binding.scopeOf.set(node, scope); }
        return scope;
    }

    // ── Pass 1: explicit declarations ────────────────────────────────────────

    private declare(stmts: A.Stmt[], scope: Scope, file: string): void {
        for (const s of stmts) {
            switch (s.kind) {
                case 'Dim':
                    for (const d of s.declarators) {
                        if (!d.name.name) { continue; }
                        // ReDim of a name this scope already has resizes it; otherwise it declares one.
                        // Inside a procedure that waits for declareProcedureLocals, as the name may
                        // be a page variable declared further down or only ever assigned.
                        if (s.keyword === 'redim' && scope.kind === 'procedure') { this.redimmedIn(scope).add(d.name.name); continue; }
                        if (s.keyword === 'redim' && this.declaredHere(scope, d.name.name)) { continue; }
                        this.add(scope, file, d.name, 'variable', false);
                    }
                    break;
                case 'Const':
                    for (const d of s.declarators) { if (d.name.name) { this.add(scope, file, d.name, 'constant', false); } }
                    break;
                case 'Procedure': {
                    const decl = this.add(scope, file, s.name, PROCEDURE_KIND[s.procKind], false, s);
                    if (decl && s.accessor) { decl.accessor = s.accessor; }
                    const body = this.newScope('procedure', scope, s);
                    for (const p of s.params) { if (p.name.name) { this.add(body, file, p.name, 'parameter', false); } }
                    this.declare(s.body, body, file);
                    break;
                }
                case 'Class': {
                    this.add(this.scriptOf(scope), file, s.name, 'class', false, s);
                    this.declare(s.members, this.newScope('class', this.scriptOf(scope), s), file);
                    break;
                }
                default:
                    for (const body of childBodies(s)) { this.declare(body, scope, file); }
            }
        }
    }

    /** Page-wide names that are only ever assigned, or used as a loop variable. */
    private declareImplicitGlobals(stmts: A.Stmt[], script: Scope, file: string): void {
        if (this.binding.optionExplicit) { return; }
        for (const s of stmts) {
            if (s.kind === 'Procedure' || s.kind === 'Class') { continue; }
            const name = implicitTarget(s);
            if (name && !script.declarations.has(name.name)) { this.add(script, file, name, 'variable', true); }
            for (const body of childBodies(s)) { this.declareImplicitGlobals(body, script, file); }
        }
    }

    /**
     * The locals each procedure makes without a Dim: a ReDim of a name nothing
     * else declares, and, without Option Explicit, a name only assigned or used
     * as a loop variable. VBScript makes them when it compiles the procedure,
     * so a use written above the line that makes one is the same local.
     */
    private declareProcedureLocals(stmts: A.Stmt[], file: string): void {
        for (const s of stmts) {
            if (s.kind === 'Procedure') {
                const scope = this.binding.scopeOf.get(s)!;
                walkBody(s.body, inner => this.declareLocal(inner, scope, file));
            } else if (s.kind === 'Class') {
                this.declareProcedureLocals(s.members, file);
            } else {
                for (const body of childBodies(s)) { this.declareProcedureLocals(body, file); }
            }
        }
    }

    private declareLocal(s: A.Stmt, scope: Scope, file: string): void {
        if (s.kind === 'Dim' && s.keyword === 'redim') {
            for (const d of s.declarators) {
                if (d.name.name && !this.lookup(scope, d.name.name)) { this.add(scope, file, d.name, 'variable', false); }
            }
            return;
        }
        if (this.binding.optionExplicit) { return; }
        const name = implicitTarget(s);
        if (name?.name && !this.lookup(scope, name.name)) { this.add(scope, file, name, 'variable', true); }
    }

    private redimmedIn(scope: Scope): Set<string> {
        let names = this.redimmed.get(scope);
        if (!names) { names = new Set(); this.redimmed.set(scope, names); }
        return names;
    }

    private declaredHere(scope: Scope, name: string): boolean {
        return scope.declarations.has(name);
    }

    /** True inside Function F (or Property F) for the name F, which is the return value. */
    private isOwnName(scope: Scope, name: string): boolean {
        const node = scope.node;
        return scope.kind === 'procedure' && node?.kind === 'Procedure' && node.procKind !== 'sub' && node.name.name === name;
    }

    private scriptOf(scope: Scope): Scope {
        let s = scope;
        while (s.parent) { s = s.parent; }
        return s;
    }

    private add(
        scope: Scope,
        file: string,
        name: A.Name,
        kind: DeclarationKind,
        implicit: boolean,
        node?: A.ProcedureStmt | A.ClassStmt,
    ): Declaration | null {
        if (!name.name) { return null; }
        const decl: Declaration = { name: name.name, text: name.text, kind, file, span: { start: name.start, end: name.end }, scope, implicit };
        if (node) { decl.node = node; }

        if (!implicit && this.redefines(scope, decl, node)) {
            this.binding.diagnostics.push({ file, start: name.start, end: name.end, message: 'Name redefined' });
        }

        const list = scope.declarations.get(decl.name);
        if (list) { list.push(decl); } else { scope.declarations.set(decl.name, [decl]); }
        this.binding.declarations.push(decl);
        this.binding.references.push({ name: decl.name, file, span: decl.span, scope, target: decl, declaration: true });
        return decl;
    }

    private redefines(scope: Scope, decl: Declaration, node?: A.ProcedureStmt | A.ClassStmt): boolean {
        if (scope.kind === 'procedure' && this.isOwnName(scope, decl.name)) { return true; }
        // A Dim after a ReDim of the name in the same procedure, even when the ReDim resized a page array.
        if (scope.kind === 'procedure' && decl.kind === 'variable' && this.redimmed.get(scope)?.has(decl.name)) { return true; }

        const earlier = (scope.declarations.get(decl.name) ?? []).filter(d => !d.implicit);
        if (earlier.length === 0) { return false; }

        const isProcedure = (k: DeclarationKind) => k === 'sub' || k === 'function';
        if (scope.kind === 'script' && isProcedure(decl.kind) && earlier.every(d => isProcedure(d.kind))) { return false; }

        if (scope.kind === 'class' && decl.kind === 'property' && node?.kind === 'Procedure') {
            return !earlier.every(d => d.kind === 'property' && d.accessor !== node.accessor);
        }
        return true;
    }

    // ── Pass 2: every use of a name ──────────────────────────────────────────

    private lookup(scope: Scope, name: string): Declaration | null {
        for (let s: Scope | null = scope; s; s = s.parent) {
            const found = s.declarations.get(name);
            // The last of several Subs of one name is the one that runs.
            if (found) { return found[found.length - 1]; }
        }
        return null;
    }

    private use(scope: Scope, file: string, name: A.Name): void {
        if (!name.name) { return; }
        const target = this.lookup(scope, name.name);
        // Its own declaration, already recorded when it was declared.
        if (target?.span.start === name.start && target.file === file) { return; }
        this.binding.references.push({ name: name.name, file, span: { start: name.start, end: name.end }, scope, target, declaration: false });
    }

    private resolve(stmts: A.Stmt[], scope: Scope, file: string): void {
        for (const s of stmts) {
            switch (s.kind) {
                case 'Dim':
                    for (const d of s.declarators) {
                        if (s.keyword === 'redim') { this.use(scope, file, d.name); }
                        for (const b of d.bounds ?? []) { this.expr(b, scope, file); }
                    }
                    break;
                case 'Const':
                    for (const d of s.declarators) { this.expr(d.value, scope, file); }
                    break;
                case 'Assign':
                    this.target(s.target, scope, file);
                    this.expr(s.value, scope, file);
                    break;
                case 'CallStmt':
                    this.expr(s.callee, scope, file);
                    for (const a of s.args) { if (a) { this.expr(a, scope, file); } }
                    break;
                case 'Output':
                    this.expr(s.value, scope, file);
                    break;
                case 'If':
                    for (const b of s.branches) {
                        if (b.condition) { this.expr(b.condition, scope, file); }
                        this.resolve(b.body, scope, file);
                    }
                    break;
                case 'Select':
                    this.expr(s.subject, scope, file);
                    for (const c of s.cases) {
                        for (const v of c.values ?? []) { this.expr(v, scope, file); }
                        this.resolve(c.body, scope, file);
                    }
                    break;
                case 'For':
                    this.use(scope, file, s.counter);
                    this.expr(s.from, scope, file);
                    this.expr(s.to, scope, file);
                    if (s.step) { this.expr(s.step, scope, file); }
                    this.resolve(s.body, scope, file);
                    break;
                case 'ForEach':
                    this.use(scope, file, s.variable);
                    this.expr(s.collection, scope, file);
                    this.resolve(s.body, scope, file);
                    break;
                case 'Do':
                    if (s.pre) { this.expr(s.pre.expr, scope, file); }
                    this.resolve(s.body, scope, file);
                    if (s.post) { this.expr(s.post.expr, scope, file); }
                    break;
                case 'While':
                    this.expr(s.condition, scope, file);
                    this.resolve(s.body, scope, file);
                    break;
                case 'With':
                    this.expr(s.object, scope, file);
                    this.resolve(s.body, scope, file);
                    break;
                case 'Erase':
                    for (const t of s.targets) { this.expr(t, scope, file); }
                    break;
                case 'Error':
                    if (s.expr) { this.expr(s.expr, scope, file); }
                    break;
                case 'Procedure':
                    this.resolve(s.body, this.binding.scopeOf.get(s)!, file);
                    break;
                case 'Class':
                    this.resolve(s.members, this.binding.scopeOf.get(s)!, file);
                    break;
            }
        }
    }

    /** Names the parser skipped after an error, read in the procedure or class they sit in. */
    private resolveSkipped(program: A.Program, script: Scope, file: string): void {
        for (const n of program.skippedNames) {
            const scope = this.scopeAt(program.body, n.start, script);
            if (n.member) {
                this.binding.members.push({ name: n.name, file, span: { start: n.start, end: n.end }, scope });
            } else {
                this.use(scope, file, n);
            }
        }
    }

    /** The scope of the innermost procedure or class around `offset`. */
    private scopeAt(stmts: A.Stmt[], offset: number, scope: Scope): Scope {
        const s = stmts.find(st => st.start <= offset && offset < st.end);
        if (!s) { return scope; }
        if (s.kind === 'Procedure') { return this.scopeAt(s.body, offset, this.binding.scopeOf.get(s)!); }
        if (s.kind === 'Class') { return this.scopeAt(s.members, offset, this.binding.scopeOf.get(s)!); }
        for (const body of childBodies(s)) {
            const inner = this.scopeAt(body, offset, scope);
            if (inner !== scope) { return inner; }
        }
        return scope;
    }

    /** The left side of an assignment: a bare name is written, anything else is read. */
    private target(e: A.Expr, scope: Scope, file: string): void {
        if (e.kind === 'Ident') { this.use(scope, file, e.name); } else { this.expr(e, scope, file); }
    }

    /**
     * The names read in an expression, in the order they are written. A chain
     * of `&`, `.` or `(…)` is a tree as deep as the chain is long, so this
     * keeps its own stack rather than recursing. A member's name waits on the
     * stack until its object has been read.
     */
    private expr(root: A.Expr, scope: Scope, file: string): void {
        const stack: (A.Expr | A.Name)[] = [root];
        while (stack.length > 0) {
            const e = stack.pop()!;
            if (!('kind' in e)) {
                this.binding.members.push({ name: e.name, file, span: { start: e.start, end: e.end }, scope });
                continue;
            }
            switch (e.kind) {
                case 'Ident':
                    this.use(scope, file, e.name);
                    break;
                case 'Member':
                    if (e.object?.kind === 'Me') {
                        this.member(e.name, scope, file);
                    } else {
                        if (e.name.name) { stack.push(e.name); }
                        if (e.object) { stack.push(e.object); }
                    }
                    break;
                case 'New':
                    this.use(scope, file, e.className);
                    break;
                default: {
                    const children = childExpressions(e);
                    for (let i = children.length - 1; i >= 0; i--) { stack.push(children[i]); }
                }
            }
        }
    }

    /** `Me.name`: a member of the class the code is in. */
    private member(name: A.Name, scope: Scope, file: string): void {
        let s: Scope | null = scope;
        while (s && s.kind !== 'class') { s = s.parent; }
        const found = s?.declarations.get(name.name);
        this.binding.references.push({
            name: name.name, file, span: { start: name.start, end: name.end }, scope,
            target: found ? found[found.length - 1] : null, declaration: false,
        });
    }
}

/** The statement lists nested directly in a block statement. */
function childBodies(s: A.Stmt): A.Stmt[][] {
    switch (s.kind) {
        case 'If':      return s.branches.map(b => b.body);
        case 'Select':  return s.cases.map(c => c.body);
        case 'For':
        case 'ForEach':
        case 'Do':
        case 'While':
        case 'With':    return [s.body];
        default:        return [];
    }
}

/** Calls `visit` on every statement of a procedure body, nested blocks included, in source order. */
function walkBody(stmts: A.Stmt[], visit: (s: A.Stmt) => void): void {
    for (const s of stmts) {
        visit(s);
        for (const body of childBodies(s)) { walkBody(body, visit); }
    }
}

/** The name a statement declares implicitly when nothing else does. */
function implicitTarget(s: A.Stmt): A.Name | null {
    if (s.kind === 'Assign' && s.target.kind === 'Ident') { return s.target.name; }
    if (s.kind === 'For') { return s.counter; }
    if (s.kind === 'ForEach') { return s.variable; }
    return null;
}
