/**
 * pageSegments.ts
 *
 * Which parts of a page are VBScript, as offsets into the page, grouped into
 * the separate programs the page really holds.
 *
 * The first program is the page flow:
 *   - `<% … %>` is code and `<%= … %>` is an output expression. The first
 *     `%>` ends the block even inside a string, as IIS does (see zoneUtils).
 *   - `<%@ … %>` is a directive and holds no code.
 *   - Any other text between two blocks is HTML. IIS compiles each such chunk
 *     into a Response.WriteBlock statement, so it matters to the grammar: HTML
 *     between `Select Case` and the first `Case` is an error. A chunk of only
 *     whitespace is just a line break.
 *
 * A page whose `<%@ Language=… %>` directive names JScript has no page flow
 * program: its `<% %>` code is JScript, and reading it as VBScript filled the
 * page with false errors.
 *
 * Each `<script language="vbscript">` body (the blocks getZone reports as the
 * asp zone) is a program of its own. A client-side one runs in the browser,
 * and even a `runat="server"` one is not part of the page flow, so a Sub in it
 * does not sit inside whatever `<% If %>` surrounds the tag.
 *
 * A file with no `<%` and no VBScript script block is read as code from end
 * to end, as the extension already does for pure-code include files, unless
 * it starts with a tag: then it is plain markup and holds no VBScript.
 *
 * Includes are not followed here. An `<!-- #include -->` is just HTML.
 */

import { getAspBlockRanges, getVbScriptBlockRanges } from '../utils/zoneUtils';

export type SegmentKind = 'code' | 'output' | 'html';

export interface Segment {
    kind: SegmentKind;
    start: number;
    end: number;
}

export interface ProgramSource {
    segments: Segment[];
    /**
     * False for a `<script language="vbscript">` without `runat="server"`:
     * it runs in the browser, so its names are not the page's.
     */
    server: boolean;
}

/**
 * The language a page's `<% %>` code is in, from its `<%@ Language=… %>`
 * directive: VBScript unless the directive names JScript (or JavaScript,
 * which IIS runs as JScript).
 */
export function pageLanguage(text: string): 'vbscript' | 'jscript' {
    const directive = /<%@([\s\S]*?)%>/.exec(text);
    const language = directive && /\blanguage\s*=\s*["']?\s*([a-z]+)/i.exec(directive[1]);
    return language && /^(?:jscript|javascript)$/i.test(language[1]) ? 'jscript' : 'vbscript';
}

export function pagePrograms(text: string): ProgramSource[] {
    const aspBlocks = getAspBlockRanges(text).map(r => ({ start: r.start, end: Math.min(r.end, text.length) }));
    const scriptBodies = getVbScriptBlockRanges(text);

    if (aspBlocks.length === 0 && scriptBodies.length === 0) {
        // Markup with no server code at all holds no VBScript.
        return /^\s*</.test(text) ? [] : [{ segments: [{ kind: 'code', start: 0, end: text.length }], server: true }];
    }

    const programs: ProgramSource[] = [];
    // A JScript page's `<% %>` code is not VBScript; only its VBScript script blocks are.
    if (pageLanguage(text) === 'vbscript') { programs.push({ segments: pageFlow(text, aspBlocks), server: true }); }

    // Each script body, less any `<% %>` block written inside it: that block
    // belongs to the page flow, and splits the script around it.
    for (const body of scriptBodies) {
        const pieces: Segment[] = [];
        let from = body.start;
        for (const block of aspBlocks) {
            if (block.end <= from || block.start >= body.end) { continue; }
            if (block.start > from) { pieces.push({ kind: 'code', start: from, end: block.start }); }
            from = Math.max(from, block.end);
        }
        if (from < body.end) { pieces.push({ kind: 'code', start: from, end: body.end }); }
        if (pieces.length > 0) { programs.push({ segments: pieces, server: runsAtServer(text, body.start) }); }
    }

    return programs;
}

/** The page flow: each `<% %>` block's code or `<%= %>` expression, and the HTML between them. */
function pageFlow(text: string, aspBlocks: { start: number; end: number }[]): Segment[] {
    const flow: Segment[] = [];
    let pos = 0;
    for (const block of aspBlocks) {
        const closed = block.end - 2 >= block.start + 2 && text.startsWith('%>', block.end - 2);
        const bodyEnd = closed ? block.end - 2 : block.end;
        // `<% = x %>` is output just like `<%= x %>`: IIS skips the whitespace.
        let markerAt = block.start + 2;
        while (markerAt < bodyEnd && /\s/.test(text[markerAt])) { markerAt++; }
        const marker = text[markerAt];

        if (marker === '@') { continue; }
        if (block.start > pos) { pushGap(text, pos, block.start, flow); }
        pos = block.end;

        if (marker === '=') {
            flow.push({ kind: 'output', start: markerAt + 1, end: Math.max(markerAt + 1, bodyEnd) });
        } else {
            flow.push({ kind: 'code', start: block.start + 2, end: bodyEnd });
        }
    }

    if (pos < text.length) { pushGap(text, pos, text.length, flow); }
    return flow;
}

/** True when the `<script>` tag whose body starts at `bodyStart` has `runat="server"`. */
function runsAtServer(text: string, bodyStart: number): boolean {
    const tagStart = text.slice(0, bodyStart).toLowerCase().lastIndexOf('<script');
    return tagStart !== -1 && /\brunat\s*=\s*["']?server\b/i.test(text.slice(tagStart, bodyStart));
}

/**
 * The text between two flow blocks becomes an HTML segment unless it is only
 * whitespace or directives.
 */
function pushGap(text: string, start: number, end: number, out: Segment[]): void {
    const gap = text.slice(start, end).replace(/<%\s*@[\s\S]*?%>/g, m => ' '.repeat(m.length));
    const first = gap.search(/\S/);
    if (first === -1) { return; }
    // Trimmed, so an error about the chunk points at the HTML itself.
    out.push({ kind: 'html', start: start + first, end: start + gap.trimEnd().length });
}
