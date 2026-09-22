import * as vscode from 'vscode';
import * as prettier from 'prettier';
import { formatSingleAspBlock, getAspSettings, delimitersAtColumnZero } from './aspFormatter';
import { findNextRealTag, findTagEnd, findClosingTag } from '../utils/zoneUtils';

// ─── Prettier settings ─────────────────────────────────────────────────────

/**
 * Prettier formatting options surfaced under the
 * `aspLanguageSupport.prettier.*` configuration namespace.
 *
 * HTML, CSS, and JavaScript formatting is delegated entirely to Prettier
 * (https://prettier.io). These settings map 1-to-1 to Prettier's own options.
 */
export interface PrettierSettings {
    printWidth:                number;
    tabWidth:                  number;
    useTabs:                   boolean;
    semi:                      boolean;
    singleQuote:               boolean;
    bracketSameLine:           boolean;
    arrowParens:               string;
    trailingComma:             string;
    endOfLine:                 string;
    htmlWhitespaceSensitivity: string;
}

export function getPrettierSettings(): PrettierSettings {
    const config = vscode.workspace.getConfiguration('aspLanguageSupport.prettier');
    return {
        printWidth:                config.get<number>('printWidth',                80),
        tabWidth:                  config.get<number>('tabWidth',                  2),
        useTabs:                   config.get<boolean>('useTabs',                  false),
        semi:                      config.get<boolean>('semi',                     true),
        singleQuote:               config.get<boolean>('singleQuote',              false),
        bracketSameLine:           config.get<boolean>('bracketSameLine',          false),
        arrowParens:               config.get<string>('arrowParens',               'always'),
        trailingComma:             config.get<string>('trailingComma',             'es5'),
        endOfLine:                 config.get<string>('endOfLine',                 'auto'),
        htmlWhitespaceSensitivity: config.get<string>('htmlWhitespaceSensitivity', 'css'),
    };
}

// ─── ASP block types ───────────────────────────────────────────────────────

// Where in the HTML structure an ASP block sits:
//   normal  – a statement block on its own line(s) → HTML comment placeholder
//   text    – a <%= … %> expression in page content → word placeholder
//   inline  – inside a quoted attribute value      → bare token placeholder
//   midtag  – between attributes, not quoted       → data- attribute placeholder
//   rawtext – inside a <script>/<style> body       → bare identifier placeholder
//             (an HTML-comment placeholder is legal JS/CSS and gets parsed by
//              Prettier — it would REORDER/corrupt the code — so raw-text blocks
//              use an identifier token Prettier leaves in place instead)
type AspBlockKind = 'normal' | 'text' | 'inline' | 'midtag' | 'rawtext';

interface AspBlock {
    code:       string;
    id:         string;
    lineNumber: number;
    kind:       AspBlockKind;
    /** The exact string emitted in place of the block, for kinds that need one. */
    token?:     string;
}

/** `<%= … %>` — Response.Write in expression form, so its output is page text. */
function isAspExpression(block: string): boolean {
    const trimmed = block.trimStart();
    return trimmed.startsWith('<%=') || trimmed.startsWith('<% =');
}

/**
 * A word-shaped stand-in for a `<%= … %>` expression in page content.
 *
 * Two properties matter, and the HTML-comment placeholder used for statement
 * blocks has neither.
 *
 * It has to read as TEXT. Prettier treats a comment as a node that cannot share
 * a line with prose, so it breaks the line around it and then moves the
 * enclosing tag's `>` down to keep the rendered whitespace unchanged — which is
 * where `<span class="info-value"\n  ><!--ID-->\n  &mdash;` comes from. Measured
 * against Prettier directly, a bare word is laid out identically to the real
 * text it stands for, while the comment is not.
 *
 * It has to be the RIGHT LENGTH. Prettier measures the MASKED line, so a
 * 30-character placeholder standing in for `<%= txtbadge %>` reports a line as
 * twice its true width and breaks one that would have fitted. Padding the token
 * to the width of the block it replaces keeps printWidth honest.
 *
 * Widening the token until the page does not already contain it is the guard
 * prettier-plugin-jinja-template uses for its own `#~1~#` tokens: a short token
 * is only safe once it is known not to collide with real content.
 */
function paddedToken(prefix: string, index: number, width: number, source: string): string {
    // The trailing `E` terminates the number, so no token can be a prefix of
    // another once both are padded — `AspExpr1E…` never occurs inside
    // `AspExpr12E…`, which matters because restoring replaces by substring.
    let token = `${prefix}${index}E`;
    if (token.length < width) { token += 'x'.repeat(width - token.length); }
    while (source.includes(token)) { token += 'x'; }
    return token;
}

// Module-level counter keeps IDs unique across calls in the same millisecond.
let _placeholderCounter = 0;

// ─── JS event attribute masking ───────────────────────────────────────────

interface JsAttrMask {
    token: string;
    original: string; // the full attribute value text, quotes excluded
    quote: string;
}

// Matches any on* event attribute whose value contains at least one `(` — those
// are the ones Prettier treats as embedded JS and wraps onto multiple lines.
const JS_EVENT_ATTR_RE = /\b(on\w+)\s*=\s*("([^"]*\([^"]*)"|'([^']*\([^']*)')/gi;

/** Replaces inline JS event-handler values with opaque tokens so Prettier
 *  cannot see the parentheses and apply its JS-expression line-wrap logic.
 *  Returns the rewritten string and a map needed to undo the masking. */
function maskJsEventAttrs(code: string): { masked: string; masks: JsAttrMask[] } {
    const masks: JsAttrMask[] = [];
    const masked = code.replace(JS_EVENT_ATTR_RE, (_, attrName, _fullVal, dq, sq) => {
        const inner = dq ?? sq;
        const quote = dq !== undefined ? '"' : "'";
        const token = `JSEVT${_placeholderCounter++}_${Date.now().toString(36)}`;
        masks.push({ token, original: inner, quote });
        return `${attrName}=${quote}${token}${quote}`;
    });
    return { masked, masks };
}

/** Restores all JS event-handler values that were masked by maskJsEventAttrs. */
function restoreJsEventAttrs(code: string, masks: JsAttrMask[]): string {
    let result = code;
    for (const { token, original, quote } of masks) {
        // Prettier may have changed the surrounding quote style — match either.
        // Use a function replacement so `$`-sequences in the original value
        // (e.g. $&, $$) are inserted literally, not interpreted by String.replace.
        result = result.replace(
            new RegExp(`["']${token}["']`),
            () => `${quote}${original}${quote}`
        );
    }
    return result;
}

// ─── Safety check ─────────────────────────────────────────────────────────

/**
 * Returns true if the source has unmatched <% or %> tags.
 * An unclosed <% would cause the masking regex to consume everything after it.
 *
 * Skips:
 *  - HTML comments  <!-- ... -->  entirely (ASP tags inside them are not real)
 *  - VBScript comment lines (first non-whitespace char is ') inside ASP blocks
 *  - %> inside string literals inside ASP blocks
 */
function hasUnclosedAspTags(code: string): boolean {
    let depth   = 0;
    let i       = 0;
    let inHtmlComment = false;

    while (i < code.length) {
        // ── HTML comment open  <!-- ──────────────────────────────────────────
        if (!inHtmlComment && depth === 0 &&
            code[i] === '<' && code.slice(i, i + 4) === '<!--') {
            inHtmlComment = true;
            i += 4;
            continue;
        }
        // ── HTML comment close  --> ──────────────────────────────────────────
        if (inHtmlComment) {
            if (code.slice(i, i + 3) === '-->') { inHtmlComment = false; i += 3; }
            else { i++; }
            continue;
        }

        // ── ASP open  <% ─────────────────────────────────────────────────────
        if (code[i] === '<' && code[i + 1] === '%') {
            depth++;
            i += 2;
            continue;
        }

        // ── Inside ASP block: scan line-by-line ──────────────────────────────
        if (depth > 0) {
            const lineEnd  = code.indexOf('\n', i);
            const lineText = lineEnd === -1 ? code.slice(i) : code.slice(i, lineEnd + 1);
            const end      = lineEnd === -1 ? code.length   : lineEnd + 1;

            // VBScript comment line — no %> on this line counts
            if (lineText.trimStart().startsWith("'")) {
                i = end;
                continue;
            }

            // Scan line for %> outside string literals
            let j = i, inStr = false, found = false;
            while (j < end) {
                if (code[j] === '"') {
                    if (inStr && j + 1 < end && code[j + 1] === '"') { j += 2; continue; }
                    inStr = !inStr; j++; continue;
                }
                if (!inStr && code[j] === '%' && j + 1 < code.length && code[j + 1] === '>') {
                    depth--;
                    if (depth < 0) { return true; }
                    j += 2; found = true; i = j; break;
                }
                j++;
            }
            if (!found) { i = end; }
            continue;
        }

        i++;
    }

    return depth !== 0;
}

// ─── ASP block classifier ─────────────────────────────────────────────────

/**
 * Determines whether an ASP block is inline (inside a quoted attribute value),
 * midtag (between unquoted attributes), or normal (free-standing).
 *
 * Takes `emittedSoFar` — everything written to maskedCode before this block —
 * so it has full forward context and never needs to guess from a backwards scan.
 * Scanning forward from the start is unambiguous: we always know whether a quote
 * opens or closes an attribute value because we track state as we go.
 */
function classifyContext(emittedSoFar: string): AspBlockKind {
    let inTag     = false;
    let attrQuote = '';
    let i         = 0;

    while (i < emittedSoFar.length) {
        const ch = emittedSoFar[i];

        if (attrQuote) {
            if (ch === attrQuote) { attrQuote = ''; }
            i++; continue;
        }

        if (inTag) {
            if (ch === '>') { inTag = false; i++; continue; }
            if (ch === '"' || ch === "'") {
                // Look back past whitespace to find '=' — handles `attr = "value"`
                let j = i - 1;
                while (j >= 0 && (emittedSoFar[j] === ' ' || emittedSoFar[j] === '\t')) { j--; }
                if (j >= 0 && emittedSoFar[j] === '=') { attrQuote = ch; i++; continue; }
            }
            i++; continue;
        }

        // Outside any tag — look for tag opens, skip HTML comments.
        if (ch === '<') {
            if (emittedSoFar.slice(i, i + 4) === '<!--') {
                const close = emittedSoFar.indexOf('-->', i + 4);
                i = close === -1 ? emittedSoFar.length : close + 3;
                continue;
            }
            const next = emittedSoFar[i + 1] ?? '';
            if (/[a-zA-Z!?/]/.test(next)) { inTag = true; }
        }
        i++;
    }

    if (attrQuote) return 'inline';
    if (inTag)     return 'midtag';
    return 'normal';
}

// ─── Raw-text (<script>/<style>) ASP handling ───────────────────────────────

/**
 * A JS/CSS-safe placeholder for an ASP block that lives inside a <script> or
 * <style> body. Must be a valid identifier in BOTH languages (lowercase so
 * Prettier's CSS printer can't rewrite its case) and derived deterministically
 * from the block id so masking, the survival check, and restore all agree.
 */
function rawTokenFor(id: string): string {
    return ('aspraw' + id).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Byte ranges [start, end) of every real <script>/<style> element BODY (between
 * the opening tag's `>` and the closing tag). Reuses the zone scanners so ASP
 * blocks, quoted attributes, and VBScript strings are handled the same way the
 * rest of the extension handles them.
 */
function computeRawTextRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const tag of ['<script', '<style'] as const) {
        const name = tag.slice(1); // 'script' | 'style'
        let from = 0;
        while (true) {
            const open = findNextRealTag(text, tag, from);
            if (open === -1) { break; }
            const tagEnd = findTagEnd(text, open);
            if (tagEnd === -1) { break; }
            const { index: close, length } = findClosingTag(text, name, tagEnd + 1);
            const bodyStart = tagEnd + 1;
            const bodyEnd   = close === -1 ? text.length : close;
            ranges.push([bodyStart, bodyEnd]);
            from = close === -1 ? text.length : close + length;
        }
    }
    return ranges;
}

function isInRawText(pos: number, ranges: Array<[number, number]>): boolean {
    return ranges.some(([s, e]) => pos >= s && pos < e);
}

// ─── Implied table end-tag normaliser ───────────────────────────────────────

/**
 * Classic ASP markup very often omits the optional </td> </tr> </th> </thead>
 * </tbody> </tfoot> end tags. Prettier's HTML parser does not apply the HTML
 * implied-end-tag rules for these, so a following <tr> is nested inside the
 * still-open <td> instead of starting a new row. This pass inserts the implied
 * closers (respecting nested <table>s, which act as a barrier) so Prettier
 * receives well-formed table structure.
 *
 * Only the table family is handled — the case that actually breaks in ASP. HTML
 * comments are skipped opaquely, so masked ASP placeholder comments are untouched,
 * and the pass is a no-op on markup that already has explicit end tags.
 */
export function insertImpliedTableEndTags(html: string): string {
    const CLOSEABLE = new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot']);
    const stack: string[] = [];
    let out = '';
    let i = 0;
    const n = html.length;

    // Emit </top> while the top of the stack should be implicitly closed. Never
    // pops past a <table> (a nested table is a barrier for cell/row closing).
    const closeWhile = (shouldClose: (top: string) => boolean): void => {
        while (stack.length && stack[stack.length - 1] !== 'table'
               && shouldClose(stack[stack.length - 1])) {
            out += '</' + stack.pop() + '>';
        }
    };

    while (i < n) {
        // HTML comment (incl. masked ASP placeholder comments) — opaque.
        if (html.startsWith('<!--', i)) {
            const end  = html.indexOf('-->', i + 4);
            const stop = end === -1 ? n : end + 3;
            out += html.slice(i, stop);
            i = stop;
            continue;
        }

        // A tag: <name …>, </name>, or <name …/>. (<%…%> is already masked away.)
        if (html[i] === '<' && /[a-zA-Z/]/.test(html[i + 1] ?? '')) {
            let j = i + 1;
            let quote = '';
            while (j < n) {
                const c = html[j];
                if (quote)                    { if (c === quote) { quote = ''; } j++; continue; }
                if (c === '"' || c === "'")   { quote = c; j++; continue; }
                if (c === '>')                { j++; break; }
                j++;
            }
            const tag       = html.slice(i, j);
            const isEnd     = tag[1] === '/';
            const selfClose = /\/\s*>$/.test(tag);
            const name      = (tag.match(/^<\/?\s*([a-zA-Z][\w:-]*)/)?.[1] ?? '').toLowerCase();

            // Insert implied closers BEFORE emitting this tag.
            if (!isEnd) {
                if (name === 'td' || name === 'th') {
                    closeWhile(t => t === 'td' || t === 'th');
                } else if (name === 'tr') {
                    closeWhile(t => t === 'td' || t === 'th' || t === 'tr');
                } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
                    closeWhile(t => CLOSEABLE.has(t));
                }
            } else {
                if (name === 'tr') {
                    closeWhile(t => t === 'td' || t === 'th');
                } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
                    closeWhile(t => t === 'td' || t === 'th' || t === 'tr');
                } else if (name === 'table') {
                    closeWhile(t => CLOSEABLE.has(t));
                }
            }

            out += tag;

            // Track table-family nesting.
            if (isEnd) {
                if (name === 'table') {
                    if (stack[stack.length - 1] === 'table') { stack.pop(); }
                } else if (CLOSEABLE.has(name)) {
                    const idx = stack.lastIndexOf(name);
                    if (idx !== -1) { stack.length = idx; }
                }
            } else if (!selfClose && (name === 'table' || CLOSEABLE.has(name))) {
                stack.push(name);
            }
            i = j;
            continue;
        }

        out += html[i];
        i++;
    }
    return out;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * True when Prettier left real content before this placeholder on its line, so
 * the block will have to be moved onto lines of its own.
 *
 * A placeholder sitting inside an unclosed quote is an attribute value, not tag
 * content — breaking the line there would split the tag open — so it does not
 * count however much text precedes it.
 */
function placeholderIsInlinePlaced(code: string, placeholder: string): boolean {
    const idx = code.indexOf(placeholder);
    if (idx === -1) { return false; }

    const lineStart = code.lastIndexOf('\n', idx - 1) + 1;
    const before    = code.slice(lineStart, idx);
    if (before.trim().length === 0) { return false; }

    let quote: string | null = null;
    for (const ch of before) {
        if (!quote && (ch === '"' || ch === "'")) { quote = ch; }
        else if (quote && ch === quote)           { quote = null; }
    }
    return quote === null;
}

export async function formatCompleteAspFile(code: string): Promise<string> {
    if (hasUnclosedAspTags(code)) {
        vscode.window.showWarningMessage(
            'Formatting skipped — unclosed <% or stray %> detected. Fix the ASP tag mismatch first.'
        );
        return code;
    }

    const aspSettings      = getAspSettings();
    const prettierSettings = getPrettierSettings();

    // ── Step 1: Mask JS event-handler attribute values ───────────────────────
    // Must happen BEFORE ASP masking so values like onclick="doA('<%= val %>'); doB()"
    // are captured whole — including embedded ASP expressions — as one opaque token.
    const { masked: jsPreMasked, masks: jsAttrMasks } = maskJsEventAttrs(code);

    // <script>/<style> body ranges — ASP blocks inside them need a JS/CSS-safe
    // identifier placeholder, not an HTML comment (which Prettier would parse as
    // a JS/CSS comment and reorder around, corrupting the code).
    const rawRanges = computeRawTextRanges(jsPreMasked);

    // ── Step 2: Mask all ASP blocks ──────────────────────────────────────────
    // Each ASP block is replaced with a placeholder that Prettier will treat as
    // valid HTML, preserving its position in the output.

    const aspBlocks: AspBlock[] = [];

    let   maskedCode     = '';
    let   pos            = 0;
    let   inHtmlComment  = false;

    while (pos < jsPreMasked.length) {
        // ── HTML comment open  <!-- ────────────────────────────────────────
        if (!inHtmlComment && jsPreMasked.slice(pos, pos + 4) === '<!--') {
            // Before entering the comment check it's not an ASP placeholder we
            // already emitted (those start with <!--ASPPH) — shouldn't happen
            // here but guard anyway.
            inHtmlComment = true;
            maskedCode   += jsPreMasked[pos];
            pos++;
            continue;
        }
        // ── HTML comment close  --> ────────────────────────────────────────
        if (inHtmlComment) {
            if (jsPreMasked.slice(pos, pos + 3) === '-->') { inHtmlComment = false; }
            maskedCode += jsPreMasked[pos];
            pos++;
            continue;
        }

        // ── ASP block  <% ... %> ──────────────────────────────────────────
        if (jsPreMasked[pos] === '<' && jsPreMasked[pos + 1] === '%') {
            // Collect any leading horizontal whitespace on this line for indent tracking
            const lineStart   = maskedCode.lastIndexOf('\n') + 1;
            const leadingWS   = maskedCode.slice(lineStart).match(/^[ \t]*/)?.[0] ?? '';

            // Find the matching %> (using the same comment-aware logic so a '
            // comment line inside the block can't close it prematurely)
            let end = pos + 2;
            while (end < jsPreMasked.length) {
                if (jsPreMasked[end] === '%' && jsPreMasked[end + 1] === '>') {
                    // Check whether this %> is on a VBScript comment line.
                    // A VBScript comment starts with ' as the first non-whitespace
                    // character INSIDE the ASP block — not just anywhere on the
                    // HTML line.  We scan from the later of: the start of the
                    // current line, or the opening <% tag itself, so that a JS
                    // single-quote that precedes the ASP block on the same line
                    // (e.g.  '<%= cmpy %>'  ) cannot trip the comment check.
                    const lineBegin      = jsPreMasked.lastIndexOf('\n', end - 1) + 1;
                    const aspContentStart = pos + 2; // first char after <%
                    const scanFrom       = Math.max(lineBegin, aspContentStart);
                    const lineUpToClose  = jsPreMasked.slice(scanFrom, end).trimStart();
                    if (!lineUpToClose.startsWith("'")) {
                        end += 2; // include the %>
                        break;
                    }
                }
                end++;
            }

            const aspBlock   = jsPreMasked.slice(pos, end);
            // A block inside a <script>/<style> body is raw-text; otherwise decide
            // from the surrounding HTML whether it is inline/midtag/normal.
            let   kind       = isInRawText(pos, rawRanges) ? 'rawtext' : classifyContext(maskedCode);
            const lineNumber = code.slice(0, pos).split('\n').length - 1;
            const index      = _placeholderCounter++;
            const id         = `ASPPH${index}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

            // A `<%= … %>` in page content is an expression whose output is part
            // of the text around it, so it is masked as text rather than as a
            // comment — see textPlaceholderFor. This applies wherever the
            // expression sits, not only where it shares a line, so that a page
            // already broken apart by the old placeholder is pulled back
            // together the next time it is formatted.
            if (kind === 'normal' && isAspExpression(aspBlock)) { kind = 'text'; }

            // `midtag` is emitted as `name="1"`, four characters more than the
            // name itself, so the name is padded to that much less.
            const token =
                kind === 'text'   ? paddedToken('AspExpr', index, aspBlock.length,     code) :
                kind === 'inline' ? paddedToken('AspAttr', index, aspBlock.length,     code) :
                kind === 'midtag' ? paddedToken('aspmid',  index, aspBlock.length - 4, code) :
                undefined;

            aspBlocks.push({ code: aspBlock, id, lineNumber, kind, token });

            // Replace leading whitespace + block with the placeholder
            // (strip the leadingWS we already emitted so the placeholder
            //  takes its place cleanly)
            if (leadingWS && maskedCode.endsWith(leadingWS)) {
                maskedCode = maskedCode.slice(0, maskedCode.length - leadingWS.length);
            }

            switch (kind) {
                case 'text':    maskedCode += token!;           break;
                case 'inline':  maskedCode += token!;           break;
                case 'midtag':  maskedCode += `${token}="1"`;   break;
                case 'rawtext': maskedCode += rawTokenFor(id);  break;
                default:        maskedCode += `<!--${id}-->`;   break;
            }
            pos = end;
            continue;
        }

        maskedCode += jsPreMasked[pos];
        pos++;
    }

    // Strip closing tags on void elements (</br>, </input>, …) that Prettier
    // hard-fails on. Done AFTER masking so a void closer that lives inside a
    // VBScript string or ASP block (e.g. Response.Write "</br>") is already a
    // placeholder here and is preserved — the previous raw-text strip silently
    // deleted it. Real HTML void closers are still removed; the structure
    // diagnostic continues to flag them for the user to fix.
    const VOID_CLOSING_TAG_RE = /<\/(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\s*>/gi;
    maskedCode = maskedCode.replace(VOID_CLOSING_TAG_RE, '');

    // Insert implied </td> </tr> … closers so Prettier doesn't mis-nest tables
    // whose optional end tags were omitted (very common in Classic ASP).
    maskedCode = insertImpliedTableEndTags(maskedCode);

    // ── Step 3: Run Prettier on the masked HTML ──────────────────────────────

    const prettierOptions: prettier.Options = {
        parser:                    'html',
        printWidth:                prettierSettings.printWidth,
        tabWidth:                  prettierSettings.tabWidth,
        useTabs:                   prettierSettings.useTabs,
        semi:                      prettierSettings.semi,
        singleQuote:               prettierSettings.singleQuote,
        bracketSameLine:           prettierSettings.bracketSameLine,
        arrowParens:               prettierSettings.arrowParens               as any,
        trailingComma:             prettierSettings.trailingComma             as any,
        endOfLine:                 prettierSettings.endOfLine                 as any,
        htmlWhitespaceSensitivity: prettierSettings.htmlWhitespaceSensitivity as any,
    };

    let prettifiedCode: string;
    try {
        prettifiedCode = await vscode.window.withProgress(
            {
                location:  vscode.ProgressLocation.Notification,
                title:     'Classic ASP: Formatting…',
                cancellable: false,
            },
            () => prettier.format(maskedCode, prettierOptions)
        );
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const lineMatch = msg.match(/\((\d+):(\d+)\)/);
        const location  = lineMatch ? ` (line ${lineMatch[1]}, col ${lineMatch[2]})` : '';

        // ── Debug: log the masked code so we can see what Prettier choked on ──
        const channel = vscode.window.createOutputChannel('ASP Formatter Debug');
        channel.clear();
        channel.appendLine('=== Prettier parse error' + location + ' ===');
        channel.appendLine('Error: ' + msg);
        channel.appendLine('');
        channel.appendLine('=== Masked code sent to Prettier ===');
        channel.appendLine(maskedCode);
        channel.appendLine('');
        channel.appendLine('=== ASP blocks classified ===');
        for (const b of aspBlocks) {
            channel.appendLine(`  line ${b.lineNumber + 1}  kind=${b.kind}  ${b.code.slice(0, 60).replace(/\n/g, '\\n')}`);
        }
        channel.show(true);

        vscode.window.showWarningMessage(
            `Formatting skipped — Prettier could not parse the HTML${location}. ` +
            `Check the "ASP Formatter Debug" output channel to see the masked code.`
        );
        return code;
    }

    // ── Step 3b: Lay the page out the way it is going to end up ─────────────
    // A statement block that Prettier left inline — `<td><!--ID-->y</td>` — is
    // about to be moved onto lines of its own during the restore. Its indent
    // was read from the whitespace immediately before the placeholder, which is
    // empty in exactly that case, so the block landed at column 0 and only
    // reached its real column on a SECOND format, once the page already had it
    // standalone. Every enclosing element behaved that way: td, div, p and span
    // all took two passes.
    //
    // Rather than predict where Prettier would have put the block, put it there
    // and ask. Splitting the placeholder onto its own line and formatting again
    // yields, in one pass, exactly what the second pass used to produce — the
    // indentation is Prettier's either way, just computed against the layout
    // that is actually going to be written out.
    //
    // The second run only happens when there is something to move.
    if (!aspSettings.aspTagsOnSameLine) {
        const toSplit = aspBlocks.filter(block =>
            block.kind === 'normal' &&
            placeholderIsInlinePlaced(prettifiedCode, `<!--${block.id}-->`));

        if (toSplit.length > 0) {
            let respaced = prettifiedCode;
            for (const block of toSplit) {
                const placeholder = `<!--${block.id}-->`;

                // Re-asked against the text as it NOW stands, not against the
                // list built before the loop. Two adjacent blocks —
                // `<% End If %><% End If %>` — are both inline-placed to begin
                // with, but splitting the first already pushes the second onto a
                // line of its own, and prepending a second newline to it leaves
                // a blank line behind.
                if (!placeholderIsInlinePlaced(respaced, placeholder)) { continue; }

                const idx = respaced.indexOf(placeholder);

                // Add only the newlines that are missing. The placeholder
                // already ends its line whenever nothing follows it, and a
                // second newline there would leave a blank line for Prettier
                // to preserve — which is the blank line this formatter was
                // just taught not to produce.
                const afterIdx  = idx + placeholder.length;
                const lineEnd   = respaced.indexOf('\n', afterIdx);
                const afterText = lineEnd === -1
                    ? respaced.slice(afterIdx)
                    : respaced.slice(afterIdx, lineEnd);
                const trailer   = afterText.trim().length > 0 ? '\n' : '';

                respaced = respaced.slice(0, idx)
                    + '\n' + placeholder + trailer
                    + respaced.slice(afterIdx);
            }
            try {
                prettifiedCode = await prettier.format(respaced, prettierOptions);
            } catch {
                // Keep the first result: a layout that needs a second format is
                // far better than refusing to format at all.
            }
        }
    }

    // ── Step 3: Verify all placeholders survived Prettier ───────────────────

    for (const block of aspBlocks) {
        const needle =
            block.kind === 'text'    ? block.token!           :
            block.kind === 'inline'  ? block.token!           :
            block.kind === 'midtag'  ? block.token!           :
            block.kind === 'rawtext' ? rawTokenFor(block.id)  :
            block.id;

        if (!prettifiedCode.includes(needle)) {
            vscode.window.showWarningMessage(
                `Formatting skipped — an ASP block on line ${block.lineNumber + 1} was removed by Prettier. ` +
                `This usually happens when a <% %> block is in an unexpected position inside an HTML tag.`
            );
            return code;
        }
    }

    // ── Step 4: Format each ASP block's VBScript content ────────────────────
    // Process blocks sequentially so each normal block can thread its ending
    // indent level into the next, enabling cross-block continuity.

    const formattedBlocks:  string[] = [];
    const blockStartLevels: number[] = [];
    const blockHtmlIndents: string[] = [];
    let   currentIndentLevel         = 0;

    for (const block of aspBlocks) {
        if (block.kind !== 'normal') {
            // Format but don't change the tracked level, and keep <% %> on one
            // line whatever aspTagsOnSameLine says.
            //
            // Every kind other than `normal` sits inside something a line break
            // would break open: a JS or CSS statement (rawtext), an attribute
            // value (inline), the gap between two attributes (midtag), or a run
            // of page text (text). Only rawtext was given this treatment, so a
            // statement between attributes was expanded to
            //
            //     <input
            //       type="text" <%
            //     If sel Then
            //     %>
            //       checked <%
            //
            // — the VBScript dedented to column 0 and the tag torn apart around it.
            const blockSettings = { ...aspSettings, aspTagsOnSameLine: true };
            const result = formatSingleAspBlock(block.code, blockSettings, '', currentIndentLevel);
            formattedBlocks.push(result.formatted);
            blockStartLevels.push(-1);
            blockHtmlIndents.push('');
            continue;
        }

        // For normal blocks, capture the HTML indent Prettier placed before
        // the placeholder comment so the VBScript formatter can use it when
        // htmlIndentMode is 'continuation'.
        const escapedId  = block.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const indentMatch = prettifiedCode.match(new RegExp(`([ \\t]*)<!--${escapedId}-->`));
        const htmlIndent  = indentMatch ? indentMatch[1] : '';

        blockStartLevels.push(currentIndentLevel);
        blockHtmlIndents.push(htmlIndent);

        const result = formatSingleAspBlock(block.code, aspSettings, htmlIndent, currentIndentLevel);
        formattedBlocks.push(result.formatted);
        currentIndentLevel = result.endLevel;
    }

    // ── Step 4b: Compute the shared tag-column for each linked group ─────────
    // In 'flat' mode, consecutive normal blocks that are part of the same
    // VBScript flow (startLevel > 0 for all but the first) share one logical
    // script.  Their <% / %> delimiters should all sit at the same column —
    // the HTML indent of the shallowest (first) block in the group — so the
    // tags form a consistent left margin regardless of HTML nesting depth.
    // A new group starts whenever a normal block has startLevel === 0.

    const blockTagIndents: string[] = new Array(aspBlocks.length).fill('');

    if (!delimitersAtColumnZero(aspSettings)) {
        let groupTagIndent = '';
        for (let i = 0; i < aspBlocks.length; i++) {
            if (aspBlocks[i].kind !== 'normal') continue;
            if (blockStartLevels[i] === 0) {
                // New group — this block's HTML indent becomes the shared tag column.
                groupTagIndent = blockHtmlIndents[i];
            }
            blockTagIndents[i] = groupTagIndent;
        }
    }

    // ── Step 5: Restore formatted ASP blocks into Prettier's output ─────────

    let restoredCode = prettifiedCode;

    for (let i = 0; i < aspBlocks.length; i++) {
        const block     = aspBlocks[i];
        const formatted = formattedBlocks[i];
        const escapedId = block.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        switch (block.kind) {

            case 'text': {
                // A word placeholder is laid out as the surrounding prose, so
                // wherever Prettier put it is where the expression belongs —
                // including on a line it wrapped onto. A straight swap is all
                // that is needed, and nothing may be done to the whitespace
                // around it: in `<span><%= a %></span>` a single space either
                // side is rendered text.
                // Function replacement keeps `$`-sequences in the code literal.
                restoredCode = restoredCode.replace(block.token!, () => formatted);
                break;
            }

            case 'rawtext': {
                // Identifier placeholder inside <script>/<style>; Prettier kept it
                // in place, so a straight swap restores the original position.
                // Function replacement keeps `$`-sequences in the code literal.
                restoredCode = restoredCode.replace(rawTokenFor(block.id), () => formatted.trim());
                break;
            }

            case 'inline': {
                const inlineToken  = block.token!;
                const escapedToken = inlineToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const isExpression = block.code.trimStart().startsWith('<%=') ||
                                     block.code.trimStart().startsWith('<% =');

                if (isExpression) {
                    // <%= ... %> is an inline expression — part of the HTML content.
                    // Restore it exactly in place without touching any surrounding
                    // whitespace.  Prettier should not have wrapped it (we pass
                    // embeddedLanguageFormatting:'off'), but even if it did we keep
                    // the expression on one line because breaking it would introduce
                    // unwanted whitespace into the rendered HTML.
                    // Function replacement: `$`-sequences in the VBScript (e.g. $&,
                    // $$ inside a string) must be inserted literally.
                    restoredCode = restoredCode.replace(inlineToken, () => formatted);
                } else {
                    // <% ... %> is a code block inside an attribute value.
                    // Prettier may have moved the token onto its own line — strip
                    // any newline + whitespace it injected before/after the token
                    // so the result doesn't break the attribute value open.
                    restoredCode = restoredCode.replace(
                        new RegExp(`(\\n[ \\t]*)?${escapedToken}([ \\t]*\\n)?`),
                        () => formatted
                    );
                }
                break;
            }

            case 'midtag':
                // Prettier may have normalised quotes/spacing around the attribute.
                // Function replacement keeps `$`-sequences in the code literal.
                restoredCode = restoredCode.replace(
                    new RegExp(`\\s*${block.token!}\\s*=\\s*["']1["']`, 'i'),
                    () => ` ${formatted}`
                );
                break;

            default: {
                const match = restoredCode.match(new RegExp(`([ \\t]*)<!--${escapedId}-->`));

                if (match) {
                    const placeholderIdx   = restoredCode.indexOf(`<!--${block.id}-->`);
                    const lineStart        = restoredCode.lastIndexOf('\n', placeholderIdx - 1) + 1;
                    const textBeforeOnLine = restoredCode.slice(lineStart, placeholderIdx);

                    // A block is "inline placed" when Prettier left non-whitespace
                    // content before the placeholder on the same line.
                    // EXCEPTION: if that content contains an unclosed quote the
                    // placeholder is sitting inside an attribute value
                    // (e.g. value="<!--ID-->" or onclick="...<!--ID-->...").
                    // In that case we must restore inline — no newlines inserted —
                    // because breaking the attribute value open corrupts the HTML.
                    const hasContentBefore = textBeforeOnLine.trimStart().length > 0;
                    const isInsideQuote    = hasContentBefore && (() => {
                        let inQ: string | null = null;
                        for (const ch of textBeforeOnLine) {
                            if (!inQ && (ch === '"' || ch === "'")) { inQ = ch; }
                            else if (inQ && ch === inQ)             { inQ = null; }
                        }
                        return inQ !== null; // still inside a quote → unclosed
                    })();
                    const isExpression     = block.code.trimStart().startsWith('<%=') ||
                                             block.code.trimStart().startsWith('<% =');
                    const isInlinePlaced   = hasContentBefore && !isInsideQuote && !isExpression;

                    if (isInlinePlaced && !aspSettings.aspTagsOnSameLine) {
                        // Block sits inline in tag text content (e.g. <td><!--ID--></td>).
                        // Expand it onto its own indented lines.
                        const baseIndent = textBeforeOnLine.match(/^([ \t]*)/)?.[1] ?? '';

                        // In flat mode use the group's shared tag column so this block's
                        // tags align with all sibling blocks in the same VBScript group.
                        const inlineTagIndent = delimitersAtColumnZero(aspSettings)
                            ? ''
                            : blockTagIndents[i];

                        const indentedBlock = formatted
                            .split('\n')
                            .map(line => {
                                if (!line.trim()) return line;
                                const t = line.trim();
                                if (t === '<%' || t === '%>') return inlineTagIndent + t;
                                return delimitersAtColumnZero(aspSettings)
                                    ? line
                                    : blockTagIndents[i] + line;
                            })
                            .join('\n');

                        // Start a new line AFTER the block only when something
                        // else is still on this one. When the placeholder ended
                        // its line, that line's own newline already separates the
                        // block from what follows, and adding another leaves a
                        // blank line behind: permanent in the middle of a file,
                        // and stripped by the NEXT format at end of file, so the
                        // file never converges.
                        const placeholder = `<!--${block.id}-->`;
                        const afterIdx    = placeholderIdx + placeholder.length;
                        const lineEnd     = restoredCode.indexOf('\n', afterIdx);
                        const restOfLine  = lineEnd === -1
                            ? restoredCode.slice(afterIdx)
                            : restoredCode.slice(afterIdx, lineEnd);
                        const endsTheLine = restOfLine.trim().length === 0;

                        restoredCode = restoredCode.replace(
                            // Trailing spaces are swallowed too when nothing
                            // follows, so the %> line is not left with whitespace
                            // the next pass would have to remove.
                            new RegExp(`[ \\t]*<!--${escapedId}-->${endsTheLine ? '[ \\t]*' : ''}`),
                            () => endsTheLine
                                ? `\n${indentedBlock}`
                                : `\n${indentedBlock}\n${baseIndent}`
                        );
                    } else {
                        // Expression sitting inline in tag text content (e.g. <td><%= val %></td>)
                        // — restore it exactly as-is with no indentation applied.
                        if (isExpression && hasContentBefore && !isInsideQuote) {
                            restoredCode = restoredCode.replace(
                                new RegExp(`[ \\t]*<!--${escapedId}-->`),
                                () => formatted.trim()
                            );
                            break;
                        }

                        // Block is either standalone on its own line, or inside a
                        // quoted attribute value — restore with correct tag indentation.
                        //
                        // How <% and %> tag lines are indented depends on htmlIndentMode:
                        //
                        // 'flat' mode  — aspFormatter starts VBScript at level 0, so
                        //   content lines have only VBScript indent (e.g. "    If ...").
                        //   The <% / %> tags should sit at the HTML placeholder's own
                        //   indent so they visually belong to the HTML structure, and
                        //   content is indented further in from there.
                        //   e.g.  <div>\n  <% ← placeholder indent, content one level in
                        //
                        // 'continuation' mode — aspFormatter already adds HTML depth to
                        //   content indent, so content is fully self-contained.
                        //   The <% / %> tags go to column 0 to avoid double-indenting.
                        //   e.g.  <%\n        If ... (HTML+VBScript indent already baked in)
                        // 'flat' mode: use the group's shared tag column (the HTML indent
                        // of the first/shallowest block in this VBScript group) so all
                        // <% / %> tags in the group align at the same column.
                        const tagIndent = delimitersAtColumnZero(aspSettings)
                            ? ''                   // tags at col 0; content has full indent
                            : blockTagIndents[i];  // shared group column

                        const indentedBlock = formatted
                            .split('\n')
                            .map(line => {
                                if (!line.trim()) return line;
                                const t = line.trim();
                                if (t === '<%' || t === '%>') return tagIndent + t;
                                // Content lines: in flat mode add the group tag indent on
                                // top of the VBScript indent aspFormatter produced.
                                // In continuation mode keep as-is (full indent baked in).
                                return delimitersAtColumnZero(aspSettings)
                                    ? line
                                    : blockTagIndents[i] + line;
                            })
                            .join('\n');

                        restoredCode = restoredCode.replace(
                            new RegExp(`[ \\t]*<!--${escapedId}-->`),
                            () => indentedBlock
                        );
                    }
                } else {
                    restoredCode = restoredCode.replace(`<!--${block.id}-->`, () => formatted);
                }
                break;
            }
        }
    }

    // ── Step 5b: Restore JS event-handler attribute values ──────────────────
    // Must happen after ASP blocks are restored so token text is never
    // accidentally matched inside a reconstructed ASP expression.
    restoredCode = restoreJsEventAttrs(restoredCode, jsAttrMasks);

    // ── Step 6: Fix broken whitespace-sensitive tags (e.g. <textarea>) ───────
    // When ASPINLINE tokens are long, Prettier wraps the closing `>` of the
    // opening tag onto its own line, and separately breaks the closing tag:
    //
    //   <textarea ...attrs...>
    //   <%= val %></textarea
    //                       >
    //
    // This is invalid for whitespace-sensitive tags because any whitespace
    // between `>` and the content becomes part of the rendered text.
    // Collapse both splits so the result is:
    //
    //   <textarea ...attrs...><%= val %></textarea>
    //
    // Pattern:
    //   (>)           — the closing > of the opening tag (already on its own line or inline)
    //   \n[ \t]*      — newline + any indentation Prettier added before the content
    //   ([^\n]+?)     — the inline content (single line, non-greedy)
    //   (<\/\w+)      — start of the closing tag (e.g. </textarea)
    //   \n[ \t]*      — newline + whitespace before the stray >
    //   (>)           — the stray > that closes the closing tag
    restoredCode = restoredCode.replace(
        /(>)\n[ \t]*([^\n]+?)(<\/\w+)\n[ \t]*(>)/g,
        '$1$2$3$4'
    );

    return restoredCode;
}