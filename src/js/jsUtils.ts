/**
 * jsUtils.ts  (js/)
 *
 * Embedded JavaScript support for .asp files — TypeScript Language Service wrapper.
 *
 * The one JsLanguageService lives on the JS worker (workers/jsAnalysisWorker.ts),
 * which answers every JavaScript feature: the colouring, squiggles and Outline
 * it works out after each edit, and the completion, hover and other queries the
 * providers send it. The page is served as two files: 'asp-embedded.js', the
 * page with everything but its script blanked, and 'asp-preamble.d.ts', the
 * declarations generated from it, so an offset in the one is an offset in the
 * page.
 *
 * The script is every JavaScript <script> body and every on…="" value
 * (onclick, onchange…), as VS Code's HTML support builds it: a value stays
 * where it is, and its closing quote becomes the `;` that ends it.
 *
 * ── ASP → JS Projection strategy ────────────────────────────────────────────
 *
 * The core problem with fake-literal placeholders ("", 0, [], false) was that
 * TypeScript narrows those to specific types, causing TS2367 errors when they
 * are later compared to other values in JS `if` / `switch` / `===` expressions.
 *
 * The solution is a TWO-PASS system:
 *
 *   PASS 1 — Preamble generation (runs over the whole document)
 *     • Every VBScript `Const` declaration is collected and declared in the
 *       preamble with its inferred TypeScript type (string | number | boolean).
 *       Consts are reliable because VBScript guarantees they are never reassigned.
 *       → e.g. `Const MAX = 10`  produces  `var _asp_MAX: number;`
 *     • Every expression slot <%= expr %> inside a JS range gets a sanitised
 *       sentinel name `_asp_<sanitized>`, declared as `var _asp_<sanitized>: any`.
 *     • A universal catch-all `var _asp: any` is always emitted so that statement
 *       blocks <% %> sitting inline in JS expressions can safely substitute to
 *       the token `_asp` without TypeScript complaining.
 *
 *   PASS 2 — Inline substitution (offset-preserving)
 *     • Statement blocks  <% code %>   →  `_asp` padded to the same width
 *     • Expression blocks <%= expr %>  →  `_asp_<sanitized>` padded to the same width
 *
 * EXAMPLES
 *   Source (.asp):
 *     <%
 *       Const MAX_ITEMS = 25
 *       Const GREETING  = "Hello"
 *       If testing = true Then Response.Write "0" Else Response.Write "10"
 *     %>
 *     <script>
 *       var x = <%= userId %>;
 *       var limit = <% If testing = true Then Response.Write "0" Else Response.Write "10" %>;
 *       if (x === "hello") { }
 *       if (<%= MAX_ITEMS %> > 0) { }
 *     </script>
 *
 *   Preamble (asp-preamble.d.ts):
 *     declare var _asp: any;                     // ← catch-all for statement blocks
 *     declare var _asp_MAX_ITEMS: number;        // ← typed from Const literal
 *     declare var _asp_GREETING: string;         // ← typed from Const literal
 *     declare var _asp_userId: any;              // ← expression sentinel
 *
 *   Virtual JS (asp-embedded.js):
 *     (blanked HTML)
 *     (blanked script tag)
 *       var x = _asp_userId  ;           // ← inline substitution, same width
 *       var limit = _asp      ...  ;     // ← statement block → _asp padded
 *       if (x === "hello") { }
 *       if (_asp_MAX_ITEMS   > 0) { }
 *     (blanked close tag)
 *
 * OFFSET PRESERVATION
 *   The virtual file is the page's length exactly: every inline replacement is
 *   as long as the ASP block it stands for (newlines kept, the rest padded with
 *   spaces), and the preamble is a file of its own. An offset TypeScript
 *   reports in VIRTUAL_FILENAME is the page's offset; a span in any other file
 *   (the preamble, the DOM types) is not in the page at all.
 */

import * as path from 'path';
import type * as ts from 'typescript';
import { getAspBlockRanges, scanMarkup, type PageMarkup } from '../core/zoneUtils';
import { endsWithContinuation, vbStatements } from '../core/vbLexical';
import { ASP_DOM_TYPES } from './aspDomTypes.generated';
import { loadTypeScript } from '../core/lazyModule';

/**
 * What a Const statement declares, from the text after `Const`:
 * `A = 1, B = "x, y"` is two constants. A comma inside a string or brackets
 * belongs to the value.
 *
 * Reading only up to the first `=` made `Const A = 1, B = 2` one constant, A,
 * whose value was `1, B = 2` — and left B out of completion, hover and rename.
 */
function parseConstDeclarators(text: string): { name: string; value: string }[] {
    const parts: string[] = [];
    let start = 0;
    let depth = 0;
    let inStr = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (inStr && text[i + 1] === '"') { i++; continue; } // "" escaped quote
            inStr = !inStr;
        } else if (!inStr) {
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; }
            else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
        }
    }
    parts.push(text.slice(start));

    const declarators: { name: string; value: string }[] = [];
    for (const part of parts) {
        const match = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/.exec(part);
        if (match) { declarators.push({ name: match[1], value: match[2] }); }
    }
    return declarators;
}

export const VIRTUAL_FILENAME    = 'asp-embedded.js';
export const PREAMBLE_FILENAME   = 'asp-preamble.d.ts';
export const ASP_DOM_TYPES_FILENAME = 'asp-dom.d.ts';

export interface VirtualJsResult {
    /** The page's script, at the page's offsets. */
    virtualContent: string;
    /** The declarations generated from the page, served as PREAMBLE_FILENAME. */
    preamble:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function blankNonNewlines(s: string): string {
    return s.replace(/[^\n]+/g, m => ' '.repeat(m.length));
}

/**
 * Turns an arbitrary VBScript expression string into a safe JS identifier
 * segment.  All non-word characters are collapsed to a single underscore,
 * and leading/trailing underscores are stripped.
 *
 * Examples:
 *   "userId"            → "userId"
 *   "Trim(userId)"      → "Trim_userId"
 *   "userId & lastName" → "userId_lastName"
 *   "RS(\"total\")"     → "RS_total"
 */
function sanitizeToIdentifier(raw: string): string {
    const sanitized = raw
        .trim()
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return sanitized || 'expr';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 1 — preamble builder
//
// Collects:
//   a) VBScript `Const` declarations anywhere in <% %> blocks, with their
//      inferred TypeScript type (string | number | boolean).  Consts are
//      guaranteed immutable in VBScript so their literal type is reliable.
//   b) Every <%= expr %> expression block inside a JS range, mapped to a
//      sanitised sentinel name _asp_<sanitized>, typed as `any`.
//   c) Always emits `var _asp: any` as a universal catch-all for statement
//      blocks that appear inline in JS expressions.
//
// Returns:
//   preamble        — the typed/any declarations, a .d.ts of their own
//   exprSentinels   — Map<aspBlock start-offset → sentinel name> used by pass 2
// ─────────────────────────────────────────────────────────────────────────────

interface PreambleResult {
    preamble: string;
    exprSentinels: Map<number, string>;  // absolute offset → sentinel name e.g. "_asp_userId"
}

/**
 * Infers the TypeScript type of a VBScript Const literal value.
 *
 * VBScript Const literals can only be:
 *   • String literals   "hello"  or  'hello'
 *   • Numeric literals  42  /  3.14  /  -1  /  &H1F (hex)
 *   • Boolean literals  True  /  False
 *
 * Anything else (e.g. a function call or variable reference on the right-hand
 * side, which is actually illegal in VBScript Const but may appear in malformed
 * code) falls back to `any`.
 */
function inferVbsConstType(value: string): string {
    const v = value.trim();
    // String literal
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
        return 'string';
    }
    // Boolean literal (VBScript is case-insensitive)
    if (/^true$/i.test(v) || /^false$/i.test(v)) {
        return 'boolean';
    }
    // Numeric literal — decimal, float, negative, or hex (&Hxx)
    if (/^-?\d+(\.\d+)?$/.test(v) || /^&H[0-9A-Fa-f]+$/i.test(v)) {
        return 'number';
    }
    return 'any';
}

/**
 * Collects all VBScript `Const` declarations from <% %> statement blocks.
 * Returns a map of identifier name → inferred TypeScript type string.
 *
 * Only `Const` is used here because it is the only VBScript construct that
 * guarantees a fixed, statically-known value — regular variables can be
 * reassigned to any type at runtime, making type inference unreliable.
 *
 * Future improvement: extend this to track Dim + single-assignment patterns,
 * or map VBScript subtype functions (CStr, CInt, CBool) to TS types.
 *
 * A light scan rather than the VBScript parser: this runs on the JavaScript
 * worker after every edit, and parsing a large page there cost ~200 ms. The
 * statements are read with the parser's lexical rules (vbLexical), so a `:`
 * or `'` inside a string is text, a comment ends the value, and a Const after
 * a `:` is found.
 */
function collectVbsConsts(content: string): Map<string, string> {
    const seen = new Set<string>();
    const consts = new Map<string, string>(); // original-cased name → TS type

    for (const block of getAspBlockRanges(content)) {
        // Closed statement blocks only: an expression block (`<%= … %>`) holds no Const.
        if (block.end > content.length || content[block.start + 2] === '=') { continue; }
        const lines = content.slice(block.start + 2, block.end - 2).split(/\r?\n/);

        // A `_` continuation joins a line to the next, as the engine reads it.
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            while (endsWithContinuation(line) && i + 1 < lines.length) { line = line.replace(/_\s*$/, ' ') + lines[++i]; }

            for (const statement of vbStatements(line)) {
                const constant = /^\s*(?:(?:Public|Private)\s+)?Const\s+(.+)$/i.exec(statement);
                if (!constant) { continue; }
                // `Const A = 1, B = "x"` declares both.
                for (const { name, value } of parseConstDeclarators(constant[1])) {
                    const key = name.toLowerCase();
                    if (seen.has(key)) { continue; }
                    seen.add(key);
                    consts.set(name, inferVbsConstType(value));
                }
            }
        }
    }

    return consts;
}

/**
 * Collects all ASP expression blocks (<%= ... %>) that fall within the given
 * JS ranges, and maps their absolute offset to a sanitised sentinel name.
 *
 * The sentinel name is `_asp_<sanitized>` where <sanitized> is the expression
 * with all non-identifier characters replaced by underscores, so that arbitrary
 * expressions like `Trim(userId)` or `userId & lastName` produce valid JS
 * identifiers (`_asp_Trim_userId`, `_asp_userId_lastName`).
 *
 * Collision note: two different expressions that sanitize to the same name
 * (e.g. `Trim(x)` and `Trim x`) share the same sentinel and both get typed
 * as `any` — this is intentional and safe since both are unknown at static
 * analysis time.
 */
function collectExprSentinels(
    content: string,
    jsRanges: ReadonlyArray<{ start: number; end: number }>
): Map<number, string> {
    const seen: Map<string, string> = new Map();
    const exprSentinels: Map<number, string> = new Map();

    for (const range of jsRanges) {
        const js = content.slice(range.start, range.end);
        const aspRegex = /<%=\s*([\s\S]*?)\s*%>/g;
        let m: RegExpExecArray | null;
        while ((m = aspRegex.exec(js)) !== null) {
            const raw = m[1];
            const sanitized = sanitizeToIdentifier(raw);
            const sentinel = '_asp_' + sanitized;
            const key = sentinel.toLowerCase();
            const absOffset = range.start + m.index;

            if (!seen.has(key)) {
                seen.set(key, sentinel);
            }
            exprSentinels.set(absOffset, seen.get(key)!);
        }
    }

    return exprSentinels;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-frame property names
//
// Classic ASP pages are full of calls into another document — a modal reaching
// back into the page that opened it:
//
//     window.parent.RefreshParentGrid(vals);
//     if (typeof(top.myCallback) == "function") { top.myCallback(retVal); }
//
// The receiver is typed Window, which of course has no RefreshParentGrid, so
// every one of these was reported as "property does not exist". There is no way
// to verify them either: the function lives in a DIFFERENT document that this
// file cannot see, so the checker has no information to work with in either
// direction. Declaring the name is therefore not hiding a bug — there is no bug
// to hide, and no check being given up.
//
// What is deliberately NOT harvested is same-frame `window.X`. A global on THIS
// page is knowable, so `window.somethingMisspelt` stays an error.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Members Window genuinely has. Declaring one of these as `any` would clash with
 * the real declaration (TS2717) and throw away type information on an API that
 * works perfectly well, so they are skipped — a cross-frame call to one of them
 * simply keeps whatever behaviour it has today.
 */
const WINDOW_OWN_MEMBERS = new Set([
    'window', 'self', 'top', 'parent', 'opener', 'frames', 'frameElement',
    'length', 'closed', 'name', 'document', 'location', 'history', 'navigator',
    'screen', 'localStorage', 'sessionStorage', 'postMessage',
    'addEventListener', 'removeEventListener', 'dispatchEvent',
    'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'focus', 'blur', 'stop',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame',
    'scroll', 'scrollTo', 'scrollBy', 'scrollX', 'scrollY',
    'pageXOffset', 'pageYOffset', 'innerWidth', 'innerHeight',
    'outerWidth', 'outerHeight', 'screenX', 'screenY', 'screenLeft', 'screenTop',
    'devicePixelRatio', 'resizeTo', 'resizeBy', 'moveTo', 'moveBy',
    'getComputedStyle', 'getSelection', 'matchMedia', 'atob', 'btoa', 'fetch',
    'console', 'crypto', 'performance', 'event',
    // Already declared in asp-dom.d.ts.
    'attachEvent', 'detachEvent', 'execScript', 'showModalDialog',
    'showModelessDialog', 'createPopup', 'clipboardData', '$', 'jQuery',
]);

/**
 * Property names read off another frame inside the document's JS ranges.
 *
 * Matches `parent.X`, `top.X`, `opener.X` and any `window.`-prefixed or chained
 * form (`window.parent.X`, `parent.parent.X`). Exported for unit testing.
 */
export function collectCrossFrameNames(
    content: string,
    jsRanges: ReadonlyArray<{ start: number; end: number }>,
): Set<string> {
    const names = new Set<string>();
    const frameChain =
        /\b(?:window\s*\.\s*)?(?:parent|top|opener)\s*(?:\.\s*(?:parent|top|opener)\s*)*\.\s*([A-Za-z_$][\w$]*)/g;

    for (const range of jsRanges) {
        const section = content.slice(range.start, range.end);
        frameChain.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = frameChain.exec(section)) !== null) {
            const name = m[1];
            // `_asp_*` stand-ins are already covered by a pattern index
            // signature in asp-dom.d.ts, so they need no per-document entry.
            if (name.startsWith('_asp_')) { continue; }
            if (WINDOW_OWN_MEMBERS.has(name)) { continue; }
            names.add(name);
        }
    }

    return names;
}

/**
 * Builds the preamble and the expression-sentinel map for the virtual file.
 * @param content   Raw ASP source text.
 * @param jsRanges  The page's JavaScript: <script> bodies and on…="" values.
 */
const NAMED_ELEMENT_TYPES: Record<string, string> = {
    form: 'HTMLFormElement', img: 'HTMLImageElement', embed: 'HTMLEmbedElement', object: 'HTMLObjectElement', iframe: 'Window',
};

function buildPreamble(
    content: string,
    jsRanges: ReadonlyArray<{ start: number; end: number }>,
    includeMarkup = '',
): PreambleResult {
    const vbsConsts = collectVbsConsts(content);
    const exprSentinels = collectExprSentinels(content, jsRanges);

    const lines: string[] = [
        // Universal catch-all: statement blocks <% %> inline in JS substitute to `_asp`
        'declare var _asp: any;',
    ];

    // Typed declarations for VBScript Const values
    for (const [name, tsType] of vbsConsts) {
        lines.push(`declare var _asp_${name}: ${tsType};`);
    }

    // Collect unique sentinel names (multiple offsets may share one sentinel)
    const uniqueSentinels = new Set(exprSentinels.values());
    for (const sentinel of uniqueSentinels) {
        // Don't re-declare if a Const with the same sanitized name already exists
        // (e.g. <%= MAX_ITEMS %> and Const MAX_ITEMS = 25 → keep the typed one)
        const withoutPrefix = sentinel.slice('_asp_'.length);
        const alreadyTyped = [...vbsConsts.keys()].some(
            k => k.toLowerCase() === withoutPrefix.toLowerCase()
        );
        if (!alreadyTyped) {
            lines.push(`declare var ${sentinel}: any;`);
        }
    }

    // Names read off another frame. These go in as an interface augmentation
    // rather than a `var`, because they are read as PROPERTIES of a Window.
    const crossFrameNames = collectCrossFrameNames(content, jsRanges);
    if (crossFrameNames.size > 0) {
        lines.push('interface Window {');
        for (const frameName of crossFrameNames) {
            lines.push(`    ${frameName}?: any;`);
        }
        lines.push('}');
    }

    // A browser puts every named form, image, embed and object, and every
    // named frame's window, on document as document.x. Only names the page and
    // its includes really have: one it lacks is still an error, as in the browser.
    const markup = content + includeMarkup;
    const named = new Map<string, string>();
    const addNamed = (name: string, type: string) => named.set(name, named.has(name) ? 'any' : type);
    for (const m of markup.matchAll(/<(form|img|embed|object|iframe)\b[^>]*?\sname\s*=\s*["']?([A-Za-z_$][\w$]*)/gi)) {
        // Two elements of one name are a collection in the browser.
        addNamed(m[2], NAMED_ELEMENT_TYPES[m[1].toLowerCase()]);
    }

    // Every element's id: getElementById('x') returns that element's own type,
    // so an <input>'s value is a string; window.x is it too; and an <object>
    // is document.x as well. The first element of an id is the one returned.
    const ids = new Map<string, string>();
    for (const m of markup.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*?\sid\s*=\s*["']?([A-Za-z_$][\w$-]*)/gi)) {
        const tag = m[1].toLowerCase();
        if (ids.has(m[2])) { continue; }
        ids.set(m[2], /^[a-z][a-z0-9]*$/.test(tag) ? `(HTMLElementTagNameMap & { [tag: string]: HTMLElement })['${tag}']` : 'HTMLElement');
        if (tag === 'object' && /^[A-Za-z_$][\w$]*$/.test(m[2])) { addNamed(m[2], 'HTMLObjectElement'); }
    }

    if (named.size > 0 || ids.size > 0) {
        lines.push('interface Document {');
        for (const [name, type] of named) { lines.push(`    ${name}: ${type};`); }
        for (const [id, type] of ids) { lines.push(`    getElementById(elementId: '${id}'): ${type};`); }
        lines.push('}');
    }
    const windowIds = [...ids].filter(([id]) => /^[A-Za-z_$][\w$]*$/.test(id));
    if (windowIds.length > 0) {
        lines.push('interface Window {');
        for (const [id, type] of windowIds) { lines.push(`    ${id}: ${type};`); }
        lines.push('}');
    }

    return { preamble: lines.join('\n') + '\n', exprSentinels };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2 — inline substitution
//
// Replaces each ASP block in the JS body with an offset-preserving token:
//   Statement block  <% code %>   →  `_asp` padded to the same character width
//   Expression block <%= expr %>  →  `_asp_<sanitized>` padded to the same width
//
// The `_asp` catch-all means statement blocks that appear inline in JS
// expressions (e.g. `var x = <% Response.Write ... %>`) produce valid JS that
// TypeScript can parse, typed as `any`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replaces a single ASP block with its offset-preserving virtual-JS token.
 *
 * @param asp       The raw ASP block text, e.g. `<%= userId %>` or `<% ... %>`.
 * @param sentinel  For expression blocks, the pre-assigned `_asp_<sanitized>` name.
 *                  Pass `undefined` for statement blocks (they substitute to `_asp`).
 */
export function substituteAspBlock(asp: string, sentinel: string | undefined): string {
    const isExpression = asp.startsWith('<%=');
    // Expression blocks stand in for a VALUE (`var x = _asp_foo`). Statement blocks
    // stand in for a STATEMENT and get a trailing `;` so that when a <% %> sits
    // inline with other JS (`a=1; <% If x %> a++;`) the placeholders don't become
    // two juxtaposed identifiers — which TypeScript flags as a syntax error (1434).
    // A leading `;` ends a statement written straight before it: `a()<% End If %>`.
    const token        = isExpression ? (sentinel ?? '_asp') : ';_asp;';

    const blanked = blankNonNewlines(asp);
    const totalLen = blanked.length;

    // The token goes in the first stretch between line breaks long enough for
    // it, and every line break stays: dropping them put the JavaScript after a
    // multi-line block onto the line of a `//` comment before it.
    let from = 0;
    while (from < totalLen) {
        const lineEnd = blanked.indexOf('\n', from);
        const end = lineEnd === -1 ? totalLen : lineEnd;
        if (end - from >= token.length) {
            return blanked.slice(0, from) + token + blanked.slice(from + token.length);
        }
        from = end + 1;
    }

    // No stretch fits: the block is laid out on lines too short for the token.
    let leadingNewlines = 0;
    while (leadingNewlines < totalLen && blanked[leadingNewlines] === '\n') {
        leadingNewlines++;
    }

    const available = totalLen - leadingNewlines;

    // Fit the token into `available` characters, padding with spaces.
    // If the token is somehow longer than the available space (shouldn't happen
    // with `_asp` = 4 chars and `<% %>` = 5 minimum), fall back to `_asp`.
    const fitted = token.length <= available
        ? token.padEnd(available, ' ').slice(0, available)
        : '_asp'.padEnd(available, ' ').slice(0, available);

    return blanked.slice(0, leadingNewlines) + fitted;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildVirtualJsContent — public entry point
// ─────────────────────────────────────────────────────────────────────────────
export function buildVirtualJsContent(content: string, markup: PageMarkup = scanMarkup(content), includeMarkup = ''): VirtualJsResult {
    const handlers = new Set(markup.eventHandlers);
    const jsRanges = [...markup.scripts.filter(s => s.language === 'javascript'), ...handlers].sort((a, b) => a.start - b.start);

    // ── Pass 1: build preamble + sentinel map ────────────────────────────────
    const { preamble, exprSentinels } = buildPreamble(content, jsRanges, includeMarkup);

    // ── Pass 2: build offset-preserving body ────────────────────────────────
    let body = '';
    let prev = 0;

    for (const range of jsRanges) {
        // Everything before (and between) script ranges → blanked spaces
        body += blankNonNewlines(content.slice(prev, range.start));

        // Walk the JS range, substituting each ASP block
        const jsSection = content.slice(range.start, range.end);
        const aspRegex = /<%[\s\S]*?%>/g;
        let jsOut = '';
        let jsPrev = 0;

        let m: RegExpExecArray | null;
        while ((m = aspRegex.exec(jsSection)) !== null) {
            const between = jsSection.slice(jsPrev, m.index);
            const absOffset = range.start + m.index;
            const sentinel = exprSentinels.get(absOffset);

            jsOut += between;
            jsOut += substituteAspBlock(m[0], sentinel);
            jsPrev = m.index + m[0].length;
        }
        jsOut += jsSection.slice(jsPrev);
        body += jsOut;
        prev = range.end;

        // A handler ends where its value does: the closing quote, or the
        // character after an unquoted value, becomes its `;`.
        const after = content[range.end];
        if (handlers.has(range) && after !== undefined && after !== '\n' && after !== '\r') {
            body += ';';
            prev++;
        }
    }

    body += blankNonNewlines(content.slice(prev));

    return { virtualContent: body, preamble };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compiler options
// ─────────────────────────────────────────────────────────────────────────────
/**
 * TypeScript itself, loaded when the first JavaScript feature needs it rather
 * than when this module is: it is by far the largest thing the extension
 * carries (~190 ms to load), and a page with no <script> never needs it.
 */
function typescript(): typeof ts {
    return loadTypeScript();
}

function makeBrowserCompilerOptions(): ts.CompilerOptions {
    return {
        target:  typescript().ScriptTarget.ES2020,
        lib:     ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
        allowJs: true,
        checkJs: true,
        noEmit:  true,
        strict:  false,
        // Prevent @types/node from leaking in and replacing browser DOM typings.
        types:   [],
        // A page's `import` or `/// <reference>` is not read from disk: hover
        // would show the contents of any file the page names.
        noResolve: true,
        noImplicitAny:                false,
        noImplicitReturns:            false,
        noUnusedLocals:               false,
        noUnusedParameters:           false,
        strictNullChecks:             false,
        strictFunctionTypes:          false,
        strictPropertyInitialization: false,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// JsLanguageService
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The trigger characters TypeScript's completion API actually accepts.
 *
 * Typed as the union so tsc checks every entry against TypeScript's own type:
 * if a future version drops one, this stops compiling rather than silently
 * passing a character that throws. Declared as a ReadonlySet<string> so it can
 * be asked about an arbitrary string.
 */
const TS_TRIGGER_CHARACTERS: ReadonlySet<string> = new Set<ts.CompletionsTriggerCharacter>([
    '.', '"', "'", '`', '/', '@', '<', '#', ' ',
]);

/**
 * True when TypeScript's completion API understands `ch` as a trigger.
 *
 * VS Code hands a provider whichever of ITS OWN registered trigger characters
 * the user typed, and that set is deliberately wider: '(' is registered so the
 * suggestion list reopens on a call. TypeScript's isValidTrigger has no case
 * for '(' and ends at `Debug.assertNever`, whose fail() runs a `debugger;`
 * statement and then throws — so one '(' typed in a <script> block halts a
 * debug session outright and, outside one, loses the completion list to a catch.
 *
 * Dropping an unknown character to undefined is also the behaviour we want:
 * that asks for a plain position-based list, which is what should appear after
 * '(' anyway.
 */
export function isTsTriggerCharacter(
    ch: string | undefined,
): ch is ts.CompletionsTriggerCharacter {
    return ch !== undefined && TS_TRIGGER_CHARACTERS.has(ch);
}

/**
 * The virtual file's text as TypeScript reads it, able to say what changed
 * since an earlier one, so TypeScript re-parses the edited stretch instead of
 * the whole script — on an 8,000-line page the full parse was ~80 ms after
 * every keystroke, before a hover or completion could answer.
 *
 * The change is worked out against the snapshot TypeScript hands back, by the
 * text the two share at the start and at the end, never from a record of the
 * edits in between. However the versions came about (another page's text, a
 * paste, a jump back), the range is right for the two texts compared.
 */
export class TextSnapshot implements ts.IScriptSnapshot {
    constructor(readonly text: string) {}

    getText(start: number, end: number): string { return this.text.substring(start, end); }

    getLength(): number { return this.text.length; }

    getChangeRange(old: ts.IScriptSnapshot): ts.TextChangeRange | undefined {
        // One TypeScript did not get from here: no change range, so a full parse.
        if (!(old instanceof TextSnapshot)) { return undefined; }
        const before = old.text;
        const after  = this.text;
        const shorter = Math.min(before.length, after.length);
        let start = 0;
        while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) { start++; }
        let endBefore = before.length;
        let endAfter  = after.length;
        while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
            endBefore--;
            endAfter--;
        }
        const ts = typescript();
        return ts.createTextChangeRange(ts.createTextSpan(start, endBefore - start), endAfter - start);
    }
}

export class JsLanguageService {
    private readonly _service:         ts.LanguageService;
    private readonly _compilerOptions: ts.CompilerOptions;
    private          _snapshot:        TextSnapshot = new TextSnapshot('');
    private          _version:         number = 0;
    private          _preamble:        ts.IScriptSnapshot;
    private          _preambleVersion: number = 0;
    private          _page:            string | undefined;
    private          _includeMarkup = '';

    /**
     * `cancellation` is asked during a long check; once it says yes, the call
     * under way throws ts.OperationCanceledException instead of answering.
     */
    constructor(cancellation?: ts.HostCancellationToken) {
        const ts = typescript();
        this._compilerOptions = makeBrowserCompilerOptions();
        const libDir = path.dirname(ts.getDefaultLibFilePath(this._compilerOptions));
        this._preamble = ts.ScriptSnapshot.fromString('');
        // Baked from src/js/asp-dom.d.ts at build time (scripts/generate-dom-types.js).
        const aspDomTypes = ts.ScriptSnapshot.fromString(ASP_DOM_TYPES);

        const self = this;
        const ownSnapshot = (f: string): ts.IScriptSnapshot | undefined =>
            f === VIRTUAL_FILENAME ? self._snapshot
            : f === PREAMBLE_FILENAME ? self._preamble
            : f === ASP_DOM_TYPES_FILENAME ? aspDomTypes
            : undefined;

        const host: ts.LanguageServiceHost = {
            getScriptFileNames:     () => [VIRTUAL_FILENAME, PREAMBLE_FILENAME, ASP_DOM_TYPES_FILENAME],
            getScriptVersion:       (f) => {
                if (f === VIRTUAL_FILENAME) return String(self._version);
                if (f === PREAMBLE_FILENAME) return String(self._preambleVersion);
                if (f === ASP_DOM_TYPES_FILENAME) return '1';
                return '0';
            },
            getScriptSnapshot:      (f) => {
                const own = ownSnapshot(f);
                if (own) { return own; }
                const text = ts.sys.readFile(f);
                return text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined;
            },
            getCompilationSettings: () => self._compilerOptions,
            getCurrentDirectory:    () => libDir,
            getDefaultLibFileName:  (opts) => ts.getDefaultLibFilePath(opts),
            fileExists:             (f) => ownSnapshot(f) !== undefined || ts.sys.fileExists(f),
            readFile:               (f) => {
                const own = ownSnapshot(f);
                return own ? own.getText(0, own.getLength()) : ts.sys.readFile(f);
            },
            readDirectory: ts.sys.readDirectory.bind(ts.sys),
            directoryExists: ts.sys.directoryExists.bind(ts.sys),
            getDirectories: ts.sys.getDirectories.bind(ts.sys),
            getCancellationToken: cancellation && (() => cancellation),
        };

        this._service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /**
     * Loads a page's script and the declarations generated from it
     * (buildVirtualJsContent). A new version makes TypeScript rebuild and
     * re-check the program on its next query, so text that has not changed
     * keeps the one it has: re-checking a large <script> on every hover cost
     * 635 ms on 8,000 lines, against 39 ms without.
     */
    updateContent(content: string, preamble = ''): void {
        this._page = undefined;
        if (content !== this._snapshot.text) {
            this._snapshot = new TextSnapshot(content);
            this._version++;
        }
        if (preamble !== this._preamble.getText(0, this._preamble.getLength())) {
            this._preamble = typescript().ScriptSnapshot.fromString(preamble);
            this._preambleVersion++;
        }
    }

    /**
     * Loads the page `text`, unless it is the page loaded already: building
     * the virtual file reads the whole page, and every query asks with it.
     * `markup` is its scanMarkup, when the caller has it; `includeMarkup` the
     * named elements its includes write (see includeNamedElements).
     */
    loadPage(text: string, markup?: PageMarkup, includeMarkup = ''): void {
        if (text === this._page && includeMarkup === this._includeMarkup) { return; }
        const { virtualContent, preamble } = buildVirtualJsContent(text, markup, includeMarkup);
        this.updateContent(virtualContent, preamble);
        this._page = text;
        this._includeMarkup = includeMarkup;
    }

    /**
     * Runs one service call. A failure answers `fallback` — a half-typed page
     * that trips TypeScript costs that one answer — but a cancellation is passed
     * on, so the worker can tell "stopped" from "nothing to say".
     */
    private ask<T>(call: () => T | undefined, fallback: T): T {
        try {
            return call() ?? fallback;
        } catch (error) {
            if (error instanceof typescript().OperationCanceledException) { throw error; }
            return fallback;
        }
    }

    getProgram(): ts.Program | undefined {
        return this.ask(() => this._service.getProgram(), undefined);
    }

    getCompletions(offset: number, trigger?: string): ts.CompletionInfo | undefined {
        return this.ask(() => this._service.getCompletionsAtPosition(VIRTUAL_FILENAME, offset, {
            triggerCharacter:                         isTsTriggerCharacter(trigger) ? trigger : undefined,
            includeCompletionsWithInsertText:         true,
            includeCompletionsForModuleExports:       false,
            includeAutomaticOptionalChainCompletions: true,
        }), undefined);
    }

    getCompletionDetails(name: string, offset: number, source?: string): ts.CompletionEntryDetails | undefined {
        return this.ask(() => this._service.getCompletionEntryDetails(
            VIRTUAL_FILENAME, offset, name, undefined, source, undefined, undefined,
        ), undefined);
    }

    getQuickInfo(offset: number): ts.QuickInfo | undefined {
        return this.ask(() => this._service.getQuickInfoAtPosition(VIRTUAL_FILENAME, offset), undefined);
    }

    getDefinitions(offset: number): readonly ts.DefinitionInfo[] {
        return this.ask(() => this._service.getDefinitionAtPosition(VIRTUAL_FILENAME, offset), []);
    }

    getReferences(offset: number): readonly ts.ReferenceEntry[] {
        return this.ask(() => this._service.getReferencesAtPosition(VIRTUAL_FILENAME, offset), []);
    }

    getDocumentHighlights(offset: number): readonly ts.DocumentHighlights[] {
        return this.ask(() => this._service.getDocumentHighlights(VIRTUAL_FILENAME, offset, [VIRTUAL_FILENAME]), []);
    }

    /**
     * Quick fixes TypeScript offers for `errorCodes` over the given span.
     *
     * The empty formatting options and preferences are deliberate: every fix
     * that matters for a Classic ASP page rewrites an identifier in place
     * ("did you mean getElementById?"), so there is no inserted block whose
     * indentation would need to match the file.
     */
    getCodeFixes(start: number, end: number, errorCodes: number[]): readonly ts.CodeFixAction[] {
        return this.ask(() => this._service.getCodeFixesAtPosition(VIRTUAL_FILENAME, start, end, errorCodes, {}, {}), []);
    }

    getRenameInfo(offset: number): ts.RenameInfo | undefined {
        return this.ask(() => this._service.getRenameInfo(VIRTUAL_FILENAME, offset, {
            providePrefixAndSuffixTextForRename: false,
        }), undefined);
    }

    findRenameLocations(offset: number): readonly ts.RenameLocation[] {
        return this.ask(() => this._service.findRenameLocations(
            VIRTUAL_FILENAME, offset, false, false, { providePrefixAndSuffixTextForRename: false },
        ), []);
    }

    getSignatureHelp(offset: number): ts.SignatureHelpItems | undefined {
        return this.ask(() => this._service.getSignatureHelpItems(VIRTUAL_FILENAME, offset, undefined), undefined);
    }

    getSyntacticDiagnostics(): ts.DiagnosticWithLocation[] {
        return this.ask(() => this._service.getSyntacticDiagnostics(VIRTUAL_FILENAME), []);
    }

    getSemanticDiagnostics(): ts.Diagnostic[] {
        return this.ask(() => this._service.getSemanticDiagnostics(VIRTUAL_FILENAME), []);
    }

    getEncodedSemanticClassifications(start: number, length: number): ts.Classifications {
        const ts = typescript();
        return this.ask(
            () => this._service.getEncodedSemanticClassifications(
                VIRTUAL_FILENAME, { start, length }, ts.SemanticClassificationFormat.TwentyTwenty,
            ),
            { spans: [], endOfLineState: ts.EndOfLineState.None },
        );
    }

    dispose(): void { this._service.dispose(); }
}

let _service: JsLanguageService | undefined;

/**
 * The one service of this thread: the JS worker's, made with the token its
 * analysis is stopped through; the unit tests make one without. This file
 * runs on the worker, where there is no vscode module and so no log: a
 * failure to start is thrown, and the worker sends it to the host to log.
 */
export function getJsLanguageService(cancellation?: ts.HostCancellationToken): JsLanguageService {
    _service ??= new JsLanguageService(cancellation);
    return _service;
}

export function disposeJsLanguageService(): void {
    _service?.dispose();
    _service = undefined;
}
