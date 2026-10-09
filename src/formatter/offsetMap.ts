/**
 * offsetMap.ts  (formatter/)
 *
 * Where a place in a rewritten copy of a page came from.
 *
 * Before Prettier sees a page, the formatter rewrites it several times: the
 * VBScript `<script>` bodies are taken out, inline event handlers and every
 * `<% %>` block are put behind placeholders (a 30-line block becomes one line),
 * stray void closers are dropped and implied table end tags are put in. When
 * Prettier then reports an error at a line and column, they are the masked
 * text's, which can be dozens of lines away from the user's. Each rewrite
 * records what it replaced where, and the maps, read back in turn, give the
 * place in the page the user wrote.
 */

export class OffsetMap {
    private readonly fromStart: number[] = [];
    private readonly fromEnd:   number[] = [];
    private readonly toStart:   number[] = [];
    private readonly toEnd:     number[] = [];

    /**
     * Records that `[fromStart, fromEnd)` of the old text became
     * `[toStart, toEnd)` of the new one. Called in order along the text; the
     * text between two replacements is the same in both.
     */
    replaced(fromStart: number, fromEnd: number, toStart: number, toEnd: number): void {
        this.fromStart.push(fromStart);
        this.fromEnd.push(fromEnd);
        this.toStart.push(toStart);
        this.toEnd.push(toEnd);
    }

    /** The old text's offset for an offset of the new text. Inside a replacement, where what it replaced starts. */
    toSource(offset: number): number {
        let lo = 0;
        let hi = this.toStart.length - 1;
        let at = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.toStart[mid] <= offset) { at = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        if (at === -1) { return offset; }
        if (offset < this.toEnd[at]) { return this.fromStart[at]; }
        return this.fromEnd[at] + (offset - this.toEnd[at]);
    }
}

/** `text.replace(pattern, replacer)`, recording each replacement in `map`. */
export function replaceRecorded(
    text: string,
    pattern: RegExp,
    replacer: (match: string, ...groups: string[]) => string,
    map: OffsetMap,
): string {
    let shift = 0;
    return text.replace(pattern, (match: string, ...rest: unknown[]) => {
        // After the groups come the offset and the whole string (and named groups, unused here).
        const offsetIndex = rest.findIndex(value => typeof value === 'number');
        const offset = rest[offsetIndex] as number;
        const replacement = replacer(match, ...(rest.slice(0, offsetIndex) as string[]));
        map.replaced(offset, offset + match.length, offset + shift, offset + shift + replacement.length);
        shift += replacement.length - match.length;
        return replacement;
    });
}

/** An offset of the last text, traced back through `maps` (oldest first) to the first. */
export function toOriginal(offset: number, maps: readonly OffsetMap[]): number {
    let at = offset;
    for (let i = maps.length - 1; i >= 0; i--) { at = maps[i].toSource(at); }
    return at;
}

/** The 0-based line of an offset of `text`. */
export function lineOf(text: string, offset: number): number {
    let line = 0;
    for (let i = 0; i < offset && i < text.length; i++) { if (text.charCodeAt(i) === 10) { line++; } }
    return line;
}

/** The offset of a 1-based line and column of `text`, as Prettier reports them. */
export function offsetOf(text: string, line: number, column: number): number {
    let at = 0;
    for (let l = 1; l < line; l++) {
        const nl = text.indexOf('\n', at);
        if (nl === -1) { return text.length; }
        at = nl + 1;
    }
    return Math.min(text.length, at + Math.max(0, column - 1));
}
