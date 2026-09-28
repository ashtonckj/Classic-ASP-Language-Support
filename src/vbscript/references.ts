/**
 * references.ts
 *
 * Every place a name is written, for rename, Find All References and Go to
 * Definition. The binder (binder.ts) says what each use of a name refers to;
 * this works out which uses are the same thing, and which pages have to be
 * read to find them all. There are three kinds of name:
 *
 *   local      a parameter, or a name declared in a Sub, Function or
 *              Property, or anything in a client-side script. Only the page
 *              the caret is on can see it.
 *   page-wide  declared outside every procedure and class, in the page or an
 *              include. Every page whose script scope holds the declaring file
 *              sees it, so each of those pages is bound on its own and the
 *              results joined: one page may resolve a use to it where another
 *              page, with other includes, does not.
 *   member     declared in a Class. Reached from outside as `obj.name`, and
 *              nothing says what class `obj` is, so every `.name` counts, and
 *              so does a member of the same name in another class.
 *
 * Imports no vscode APIs: the caller says how to read files and which files
 * include which, so the editor and the tests share it.
 */

import type * as A from './ast';
import { bindScriptScope, type Binding, type Declaration, type Scope } from './binder';
import { buildScriptScope, type ScopeHost } from './scriptScope';
import { lineAt, type ParsedPage } from './symbols';

export type Target =
    | { kind: 'local'; name: string; scope: Scope }
    | { kind: 'page'; name: string }
    | { kind: 'member'; name: string };

/** One place a name is written. */
export interface Site {
    file: string;
    /** The name itself; inside the brackets of a `[bracketed]` name. */
    start: number;
    end: number;
    line: number;
    character: number;
    /** Dim, Const, ReDim of a new name, a parameter, or a Sub, Function, Property or Class name. */
    declaration: boolean;
}

export interface WorkspaceHost extends ScopeHost {
    /** The files that include `path` directly. */
    includedBy(path: string): string[];
}

/** A page bound with its includes. */
export interface BoundPage {
    /** The page at the root of the script scope. */
    path: string;
    binding: Binding;
    pages: Map<string, ParsedPage>;
}

const key = (path: string) => path.toLowerCase();

export function bindAt(host: ScopeHost, path: string): BoundPage | null {
    const text = host.read(path);
    if (text === null) { return null; }
    const scope = buildScriptScope(path, text, host);
    return { path, binding: bindScriptScope(scope), pages: new Map(scope.files.map(f => [key(f.path), f.page])) };
}

function targetOf(binding: Binding, d: Declaration): Target {
    const script = binding.scopes[0];
    if (d.scope === script) { return { kind: 'page', name: d.name }; }
    if (d.scope.kind === 'class' && d.scope.parent === script) { return { kind: 'member', name: d.name }; }
    return { kind: 'local', name: d.name, scope: d.scope };
}

function sameTarget(a: Target, b: Target): boolean {
    return a.kind === b.kind && a.name === b.name && (a.kind !== 'local' || a.scope === (b as typeof a).scope);
}

function rootOf(scope: Scope): Scope {
    let s = scope;
    while (s.parent) { s = s.parent; }
    return s;
}

const covers = (span: A.Span, offset: number) => span.start <= offset && offset <= span.end;

/** What the name at `offset` of `file` refers to, or null when it names nothing the page declares. */
export function targetAt(binding: Binding, file: string, offset: number): Target | null {
    const inFile = key(file);
    const ref = binding.references.find(r => key(r.file) === inFile && covers(r.span, offset));
    if (ref) { return ref.target ? targetOf(binding, ref.target) : null; }

    const member = binding.members.find(m => key(m.file) === inFile && covers(m.span, offset));
    if (member && binding.declarations.some(d => d.name === member.name && targetOf(binding, d).kind === 'member')) {
        return { kind: 'member', name: member.name };
    }
    return null;
}

/** The declarations `target` stands for in one binding. */
export function declarationsOf(binding: Binding, target: Target): Declaration[] {
    return binding.declarations.filter(d => d.name === target.name && sameTarget(targetOf(binding, d), target));
}

/** Every place `target` is written in one binding. */
export function sitesIn(bound: BoundPage, target: Target): Site[] {
    const { binding } = bound;
    const sites: Site[] = [];
    const add = (file: string, span: A.Span, declaration: boolean) => {
        const page = bound.pages.get(key(file));
        if (!page) { return; }
        const bracketed = page.text[span.start] === '[';
        const start = bracketed ? span.start + 1 : span.start;
        const end = bracketed ? span.end - 1 : span.end;
        const line = lineAt(page, start);
        sites.push({ file, start, end, line, character: start - page.lineStarts[line], declaration });
    };

    for (const r of binding.references) {
        if (r.target && sameTarget(targetOf(binding, r.target), target)) {
            add(r.file, r.span, r.declaration && !r.target.implicit);
        }
    }
    if (target.kind === 'member') {
        for (const m of binding.members) {
            if (m.name === target.name && rootOf(m.scope) === binding.scopes[0]) { add(m.file, m.span, false); }
        }
    }
    return sites;
}

/**
 * The name at `offset` of `path`, bound. The page's own binding answers
 * first; when it knows nothing of the name, the pages that include this file
 * are asked, since an include often uses a name its page declares.
 */
export function resolveAt(
    host: WorkspaceHost,
    path: string,
    offset: number,
): { bound: BoundPage; target: Target } | null {
    const home = bindAt(host, path);
    const found = home && targetAt(home.binding, path, offset);
    if (home && found) { return { bound: home, target: found }; }

    const seen = new Set([key(path)]);
    const queue = [...host.includedBy(path)];
    while (queue.length > 0) {
        const page = queue.shift()!;
        if (seen.has(key(page))) { continue; }
        seen.add(key(page));
        const bound = bindAt(host, page);
        const target = bound && targetAt(bound.binding, path, offset);
        if (bound && target) { return { bound, target }; }
        queue.push(...host.includedBy(page));
    }
    return null;
}

/**
 * Every place the name at `offset` of `path` is written, in every file that
 * can see it; null when it names nothing any page declares.
 */
export function findSites(host: WorkspaceHost, path: string, offset: number): Site[] | null {
    const resolved = resolveAt(host, path, offset);
    if (!resolved) { return null; }
    const { bound, target } = resolved;
    if (target.kind === 'local') { return sitesIn(bound, target); }

    // Every page whose script scope holds the caret's file or a file that
    // declares the name. Binding one can turn up another declaring file, such
    // as a second include that declares the same page-wide name.
    const pages: string[] = [];
    const reached = new Set<string>();
    const reach = (file: string) => {
        if (reached.has(key(file))) { return; }
        reached.add(key(file));
        pages.push(file);
        for (const parent of host.includedBy(file)) { reach(parent); }
    };
    reach(path);
    for (const d of declarationsOf(bound.binding, target)) { reach(d.file); }

    const found = new Map<string, Site>();
    for (let i = 0; i < pages.length; i++) {
        const page = key(pages[i]) === key(bound.path) ? bound : bindAt(host, pages[i]);
        if (!page) { continue; }
        for (const site of sitesIn(page, target)) {
            const at = `${key(site.file)}:${site.start}`;
            const known = found.get(at);
            if (!known) { found.set(at, site); } else if (site.declaration) { known.declaration = true; }
        }
        for (const d of declarationsOf(page.binding, target)) { reach(d.file); }
    }
    return [...found.values()];
}
