/**
 * ignoreComments.ts  (core/)
 *
 * Comments that silence a diagnostic, in whatever comment the place allows:
 *
 *     ' asp-ignore-next-line missing-set          VBScript
 *     <!-- asp-ignore-next-line html-tag -->      markup
 *     // asp-ignore-next-line 2339                JavaScript
 *     /* asp-ignore-file css-unknown-properties *\/
 *     <% ' asp-ignore-file %>                     every code, the whole page
 *
 * `asp-ignore-next-line` covers the line after the comment; `asp-ignore-file`
 * the whole page. The codes are the ones the Problems panel shows, separated by
 * commas or spaces; with none, every code is silenced. No setting is involved:
 * the comment travels with the page, so whoever opens it next sees the same.
 */

/** The codes a directive silences, or `all`. */
export type IgnoredCodes = ReadonlySet<string> | 'all';

export interface IgnoreDirectives {
    /** For the whole page. */
    file: IgnoredCodes | undefined;
    /** By the 0-based line silenced: the line after the comment. */
    lines: ReadonlyMap<number, IgnoredCodes>;
}

/** One directive as written: where, which kind, and its codes. */
export interface IgnoreDirective {
    kind: 'next-line' | 'file';
    /** 0-based line the comment is on. */
    line: number;
    codes: string[];
    /** Where the list of codes ends in the page, so a code can be added after it. */
    codesEnd: number;
}

const DIRECTIVE = /(?:'|\brem\b|<!--|\/\/|\/\*)[ \t]*asp-ignore-(next-line|file)\b([^\r\n]*)/gi;

/** The text of a directive's code list: up to the end of its comment. */
function codeList(rest: string): string {
    const end = rest.search(/-->|\*\/|%>/);
    return end === -1 ? rest : rest.slice(0, end);
}

/** Every directive in `text`, in order. */
export function findIgnoreDirectives(text: string): IgnoreDirective[] {
    if (!/asp-ignore-/i.test(text)) { return []; }
    const found: IgnoreDirective[] = [];
    let line = 0;
    let counted = 0;
    DIRECTIVE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DIRECTIVE.exec(text)) !== null) {
        for (; counted < m.index; counted++) { if (text.charCodeAt(counted) === 10) { line++; } }
        const list = codeList(m[2]);
        const listStart = m.index + m[0].length - m[2].length;
        found.push({
            kind: m[1].toLowerCase() as 'next-line' | 'file',
            line,
            codes: list.split(/[\s,]+/).filter(Boolean).map(code => code.toLowerCase()),
            codesEnd: listStart + list.trimEnd().length,
        });
    }
    return found;
}

function merge(a: IgnoredCodes | undefined, codes: string[]): IgnoredCodes {
    if (a === 'all' || codes.length === 0) { return 'all'; }
    return new Set([...(a ?? []), ...codes]);
}

/** What the page's directives silence. */
export function ignoreDirectives(text: string): IgnoreDirectives {
    let file: IgnoredCodes | undefined;
    const lines = new Map<number, IgnoredCodes>();
    for (const directive of findIgnoreDirectives(text)) {
        if (directive.kind === 'file') { file = merge(file, directive.codes); }
        else { lines.set(directive.line + 1, merge(lines.get(directive.line + 1), directive.codes)); }
    }
    return { file, lines };
}

const covers = (codes: IgnoredCodes | undefined, code: string) => codes !== undefined && (codes === 'all' || codes.has(code));

/** True when a problem with `code` starting on `line` is silenced. */
export function isIgnored(directives: IgnoreDirectives, line: number, code: string | number | undefined): boolean {
    const key = String(code ?? '').toLowerCase();
    return covers(directives.file, key) || covers(directives.lines.get(line), key);
}
