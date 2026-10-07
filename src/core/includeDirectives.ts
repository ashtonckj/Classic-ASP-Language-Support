import * as path from 'path';

/**
 * includeDirectives.ts
 *
 * Parsing and resolving `<!--#include file="…"-->` / `virtual="…"` directives.
 *
 * Imports no vscode APIs, so the include worker can use it too. That is the
 * point of it existing: the same directive pattern and the same file/virtual
 * resolution rules were written out three times — once for the synchronous
 * path, once for the worker's request builder, once inside the worker — and
 * three copies of a rule is three chances for them to disagree about what
 * counts as an include.
 */

export interface IncludeDirective {
    type: 'file' | 'virtual';
    /** The path exactly as written in the directive, before resolution. */
    raw: string;
    /** Offset of the whole directive within the text it was parsed from. */
    index: number;
}

// One shared instance rather than a literal inside the function: this is called
// per line by the document-link provider, so allocating a regex per call put a
// compile on every line of every open document, every time links refreshed.
const INCLUDE_PATTERN = /<!--\s*#include\s+(file|virtual)\s*=\s*["']([^"']+)["']\s*-->/gi;

/** Every #include directive in `text`, in source order. */
export function parseIncludeDirectives(text: string): IncludeDirective[] {
    // A /g regex carries lastIndex between calls, so reset before every scan.
    // Safe because this runs to completion synchronously.
    const pattern = INCLUDE_PATTERN;
    pattern.lastIndex = 0;

    const found: IncludeDirective[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        found.push({ type: match[1].toLowerCase() as 'file' | 'virtual', raw: match[2], index: match.index });
    }
    return found;
}

/**
 * Absolute path for one directive. `virtual="/x"` is resolved from the
 * application root, `file="x"` relative to the file containing the directive —
 * which is what IIS itself does.
 */
export function resolveIncludeDirective(
    directive: IncludeDirective,
    documentPath: string,
    virtualRoot: string,
): string {
    return directive.type === 'virtual'
        ? path.join(virtualRoot, directive.raw.replace(/^\//, ''))
        : path.resolve(path.dirname(documentPath), directive.raw);
}

/** A directive path to rewrite: where it is written, and what to write instead. */
export interface IncludeRewrite {
    start:   number;
    end:     number;
    newPath: string;
}

/**
 * How the #include directives in one file have to change after files moved.
 *
 * `oldDocPath` is where the file was when its directives were written and
 * `newDocPath` where it is now — the same unless it moved too. `moved` maps a
 * path from before the move to where it went, or undefined for a path that did
 * not move; `exists` says whether a path is a file now.
 *
 * Two things break a directive. The file it names moved, so it has to name the
 * new place; or, for `file="…"` only, the including file moved, so the relative
 * path starts from somewhere else. `virtual="…"` starts at the site root, so the
 * including file moving leaves it right. A directive that did not resolve
 * before the move is left as it was — there is no telling what it meant.
 *
 * A new path keeps the directive's own style: `/` unless it was written with
 * `\`, and `virtual` paths start at `/`.
 */
export function rewriteIncludesAfterMove(
    text: string,
    oldDocPath: string,
    newDocPath: string,
    virtualRoot: string,
    moved: (fsPath: string) => string | undefined,
    exists: (fsPath: string) => boolean,
): IncludeRewrite[] {
    const rewrites: IncludeRewrite[] = [];
    const docMoved = oldDocPath !== newDocPath;

    for (const directive of parseIncludeDirectives(text)) {
        const before = resolveIncludeDirective(directive, oldDocPath, virtualRoot);
        const after  = moved(before) ?? before;
        const targetMoved = after !== before;

        if (!targetMoved && (!docMoved || directive.type === 'virtual')) { continue; }
        if (!exists(after)) { continue; }

        let newPath = directive.type === 'virtual'
            ? path.relative(virtualRoot, after)
            : path.relative(path.dirname(newDocPath), after);
        if (directive.type === 'virtual' && (newPath.startsWith('..') || path.isAbsolute(newPath))) { continue; }

        const backslashes = directive.raw.includes('\\') && !directive.raw.includes('/');
        newPath = backslashes ? newPath.replace(/\//g, '\\') : newPath.replace(/\\/g, '/');
        if (directive.type === 'virtual') { newPath = (backslashes ? '\\' : '/') + newPath; }

        if (newPath.toLowerCase() === directive.raw.toLowerCase()) { continue; }

        const start = text.indexOf(directive.raw, directive.index);
        rewrites.push({ start, end: start + directive.raw.length, newPath });
    }
    return rewrites;
}

/**
 * `moved` for rewriteIncludesAfterMove, from the renames VS Code reports. A
 * renamed folder moves everything under it. Paths compare without case, as
 * IIS and Windows do.
 */
export function movedPathLookup(renames: { oldPath: string; newPath: string }[]): (fsPath: string) => string | undefined {
    return fsPath => {
        const lower = fsPath.toLowerCase();
        for (const { oldPath, newPath } of renames) {
            const from = oldPath.toLowerCase();
            if (lower === from) { return newPath; }
            if (lower.startsWith(from) && (lower[from.length] === path.sep || lower[from.length] === '/')) {
                return newPath + fsPath.slice(oldPath.length);
            }
        }
        return undefined;
    };
}

/** Convenience for callers that want resolved paths and nothing else. */
export function resolveIncludePathsIn(
    text: string,
    documentPath: string,
    virtualRoot: string,
): string[] {
    return parseIncludeDirectives(text)
        .map(directive => resolveIncludeDirective(directive, documentPath, virtualRoot));
}
