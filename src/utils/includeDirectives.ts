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

/** Convenience for callers that want resolved paths and nothing else. */
export function resolveIncludePathsIn(
    text: string,
    documentPath: string,
    virtualRoot: string,
): string[] {
    return parseIncludeDirectives(text)
        .map(directive => resolveIncludeDirective(directive, documentPath, virtualRoot));
}
