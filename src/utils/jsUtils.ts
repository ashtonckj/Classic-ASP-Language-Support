/**
 * jsUtils.ts  (utils/)
 *
 * Embedded JavaScript support for .asp files — TypeScript Language Service wrapper.
 *
 * Maintains a single JsLanguageService singleton that is shared across all JS
 * providers (completion, hover, diagnostics, semantic tokens, document symbols).
 * The virtual file 'asp-embedded.js' is updated with projected content before each
 * query so offset positions stay exact across the whole document.
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
 *   Virtual JS produced:
 *     var _asp: any;                     // ← catch-all for statement blocks
 *     var _asp_MAX_ITEMS: number;        // ← typed from Const literal
 *     var _asp_GREETING: string;         // ← typed from Const literal
 *     var _asp_userId: any;              // ← expression sentinel
 *
 *     (blanked HTML)
 *     (blanked script tag)
 *       var x = _asp_userId  ;           // ← inline substitution, same width
 *       var limit = _asp      ...  ;     // ← statement block → _asp padded
 *       if (x === "hello") { }
 *       if (_asp_MAX_ITEMS   > 0) { }
 *     (blanked close tag)
 *
 * OFFSET PRESERVATION
 *   The preamble is prepended — it shifts every body offset by `preambleLength`
 *   characters inside the virtual file.  All providers MUST:
 *     • ADD    preambleLength to cursor/hover offsets before querying the TS service.
 *     • SUBTRACT preambleLength from diagnostic/token/span start positions before
 *       reporting back to VS Code (document.positionAt).
 *
 *   Within the body, every inline replacement is the same byte-length as the
 *   original ASP block (newlines preserved, non-newlines padded with spaces),
 *   so body-relative positions are unmoved.
 */

import * as path from 'path';
import type * as ts from 'typescript';
import { getJsBlockRanges, getZone } from './zoneUtils';
import { ASP_DOM_TYPES } from './aspDomTypes.generated';

export const VIRTUAL_FILENAME    = 'asp-embedded.js';
export const ASP_DOM_TYPES_FILENAME = 'asp-dom.d.ts';

// ─────────────────────────────────────────────────────────────────────────────
// VirtualJsResult
// ─────────────────────────────────────────────────────────────────────────────
export interface VirtualJsResult {
    virtualContent: string;
    isInScript:     boolean;
    /**
     * Number of characters in the generated preamble that was prepended to the
     * virtual content.  Every provider MUST:
     *   • ADD    preambleLength to cursor/hover/offset before querying the TS service.
     *   • SUBTRACT preambleLength from diagnostic/token/span positions before
     *     reporting back to VS Code (document.positionAt).
     */
    preambleLength: number;
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
//   preamble        — the typed/any declarations to prepend
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
 */
// Returns the part of `s` before the first `:` that sits OUTSIDE a string literal
// (a VBScript statement separator). A `:` inside "…" (e.g. a URL) is kept.
export function cutAtStatementColon(s: string): string {
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"') {
            if (s[i + 1] === '"') { i++; continue; } // "" escaped quote
            inStr = !inStr;
        } else if (ch === ':' && !inStr) {
            return s.slice(0, i);
        }
    }
    return s;
}

function collectVbsConsts(content: string): Map<string, string> {
    const seen = new Set<string>();
    const consts = new Map<string, string>(); // original-cased name → TS type

    // Only statement blocks — not expression blocks
    const aspRegex = /<%(?!=)([\s\S]*?)%>/g;
    let m: RegExpExecArray | null;
    while ((m = aspRegex.exec(content)) !== null) {
        const block = m[1].replace(/ _\r?\n/g, ' ');

        // Matches:  Const NAME = <value to end of line>. The value is then cut at a
        // statement-separating `:` that is OUTSIDE a string, so a URL literal like
        // "http://x" keeps its `:` (and is typed `string`) instead of being
        // truncated to "http (which fell back to `any`).
        const constRegex = /^\s*Const\s+([A-Za-z_]\w*)\s*=\s*(.+)$/gim;
        let c: RegExpExecArray | null;
        while ((c = constRegex.exec(block)) !== null) {
            const name = c[1];
            const key = name.toLowerCase();
            if (seen.has(key)) { continue; }
            seen.add(key);
            consts.set(name, inferVbsConstType(cutAtStatementColon(c[2])));
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
    jsRanges: Array<{ start: number; end: number }>
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
    jsRanges: Array<{ start: number; end: number }>,
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
 * @param jsRanges  Pre-computed JS script ranges (from getJsBlockRanges).
 */
function buildPreamble(
    content: string,
    jsRanges: Array<{ start: number; end: number }>
): PreambleResult {
    const vbsConsts = collectVbsConsts(content);
    const exprSentinels = collectExprSentinels(content, jsRanges);

    const lines: string[] = [
        '// [asp-projection] preamble — auto-generated, do not edit',
        // Universal catch-all: statement blocks <% %> inline in JS substitute to `_asp`
        'var _asp: any;',
    ];

    // Typed declarations for VBScript Const values
    for (const [name, tsType] of vbsConsts) {
        lines.push(`var _asp_${name}: ${tsType};`);
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
            lines.push(`var ${sentinel}: any;`);
        }
    }

    // Names read off another frame. These go in as an interface augmentation
    // rather than a `var`, because they are read as PROPERTIES of a Window.
    // TypeScript reports a grammar error for TS syntax in this .js projection
    // -- the same one `var _asp: any` above already produces -- and the binder
    // merges the interface anyway. Preamble diagnostics sit before every JS
    // range, so the diagnostics filter drops them.
    const crossFrameNames = collectCrossFrameNames(content, jsRanges);
    if (crossFrameNames.size > 0) {
        lines.push('interface Window {');
        for (const frameName of crossFrameNames) {
            lines.push(`    ${frameName}?: any;`);
        }
        lines.push('}');
    }

    lines.push('');
    const preamble = lines.join('\n') + '\n';

    return { preamble, exprSentinels };
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
    const token        = isExpression ? (sentinel ?? '_asp') : '_asp;';

    const blanked = blankNonNewlines(asp);
    const totalLen = blanked.length;

    // Count any leading newlines — these must be preserved in the output so
    // that line numbers stay correct.
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
export function buildVirtualJsContent(content: string, offset: number): VirtualJsResult {
    const jsRanges = getJsBlockRanges(content);
    const isInScript = jsRanges.some(r => offset >= r.start && offset <= r.end);

    // ── Pass 1: build preamble + sentinel map ────────────────────────────────
    const { preamble, exprSentinels } = buildPreamble(content, jsRanges);
    const preambleLength = preamble.length;

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
    }

    body += blankNonNewlines(content.slice(prev));

    return {
        virtualContent: preamble + body,
        isInScript,
        preambleLength,
    };
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
    return require('typescript') as typeof ts;
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

/** A range of the real document, in offsets. */
export interface DocumentSpan { start: number; end: number; }

/**
 * Maps a span reported by the language service back into the document.
 *
 * Returns undefined when the span is not part of the document at all, which is
 * the common case and not an error: the virtual file begins with a generated
 * preamble (the ambient `_asp` values, the cross-frame names, the VBScript
 * constants), and the service also answers with positions in lib.dom.d.ts and
 * in the ambient declarations. None of those are places a reader can be sent or
 * an edit can be applied, so every caller has to drop them.
 */
export function toDocumentSpan(
    fileName:       string,
    textSpan:       ts.TextSpan,
    preambleLength: number,
): DocumentSpan | undefined {
    if (fileName !== VIRTUAL_FILENAME) { return undefined; }
    const start = textSpan.start - preambleLength;
    if (start < 0) { return undefined; }
    return { start, end: start + textSpan.length };
}

export class JsLanguageService {
    private readonly _service:         ts.LanguageService;
    private readonly _compilerOptions: ts.CompilerOptions;
    private          _content:         string = '';
    private          _version:         number = 0;
    private readonly _aspDomTypes:     string;

    constructor() {
        const ts = typescript();
        this._compilerOptions = makeBrowserCompilerOptions();
        const libDir = path.dirname(ts.getDefaultLibFilePath(this._compilerOptions));

        this._aspDomTypes = this.aspDomTypes();

        const self = this;

        const host: ts.LanguageServiceHost = {
            getScriptFileNames:     () => [VIRTUAL_FILENAME, ASP_DOM_TYPES_FILENAME],
            getScriptVersion:       (f) => {
                if (f === VIRTUAL_FILENAME) return String(self._version);
                if (f === ASP_DOM_TYPES_FILENAME) return '1';
                return '0';
            },
            getScriptSnapshot:      (f) => {
                if (f === VIRTUAL_FILENAME) { return ts.ScriptSnapshot.fromString(self._content); }
                if (f === ASP_DOM_TYPES_FILENAME) { return ts.ScriptSnapshot.fromString(self._aspDomTypes); }
                const text = ts.sys.readFile(f);
                return text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined;
            },
            getCompilationSettings: () => self._compilerOptions,
            getCurrentDirectory:    () => libDir,
            getDefaultLibFileName:  (opts) => ts.getDefaultLibFilePath(opts),
            fileExists:             (f) => {
                if (f === VIRTUAL_FILENAME || f === ASP_DOM_TYPES_FILENAME) return true;
                return ts.sys.fileExists(f);
            },
            readFile:               (f) => {
                if (f === VIRTUAL_FILENAME) return self._content;
                if (f === ASP_DOM_TYPES_FILENAME) return self._aspDomTypes;
                return ts.sys.readFile(f);
            },
            readDirectory: ts.sys.readDirectory.bind(ts.sys),
            directoryExists: ts.sys.directoryExists.bind(ts.sys),
            getDirectories: ts.sys.getDirectories.bind(ts.sys),
        };

        this._service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /**
     * Ambient browser declarations served to the language service as a second
     * virtual file.
     *
     * The single source of truth is src/utils/asp-dom.d.ts — a real declaration
     * file, so tsc type-checks it as part of the build and a clash with
     * lib.dom.d.ts fails the compile instead of silently doing nothing here.
     * `npm run compile` bakes it into aspDomTypes.generated.ts, so there is no
     * runtime file read and nothing can go missing from the package.
     */
    private aspDomTypes(): string {
        return ASP_DOM_TYPES;
    }

    updateContent(content: string): void {
        // A new version makes TypeScript rebuild and re-check the program on its
        // next query. Every hover, completion and occurrence highlight projects
        // the page afresh, and between two keystrokes the projection is the same
        // text — bumping regardless re-checked a large <script> on every mouse
        // rest and every cursor move (635 ms a hover on 8,000 lines, 39 ms without).
        if (content === this._content) { return; }
        this._content = content;
        this._version++;
    }

    getProgram(): ts.Program | undefined {
        try { return this._service.getProgram() ?? undefined; }
        catch { return undefined; }
    }

    getCompletions(offset: number, trigger?: string): ts.CompletionInfo | undefined {
        try {
            return this._service.getCompletionsAtPosition(VIRTUAL_FILENAME, offset, {
                triggerCharacter:                         isTsTriggerCharacter(trigger) ? trigger : undefined,
                includeCompletionsWithInsertText:         true,
                includeCompletionsForModuleExports:       false,
                includeAutomaticOptionalChainCompletions: true,
            }) ?? undefined;
        } catch { return undefined; }
    }

    getCompletionDetails(name: string, offset: number, source?: string): ts.CompletionEntryDetails | undefined {
        try {
            return this._service.getCompletionEntryDetails(
                VIRTUAL_FILENAME, offset, name, undefined, source, undefined, undefined
            ) ?? undefined;
        } catch { return undefined; }
    }

    getQuickInfo(offset: number): ts.QuickInfo | undefined {
        try { return this._service.getQuickInfoAtPosition(VIRTUAL_FILENAME, offset) ?? undefined; }
        catch { return undefined; }
    }

    getDefinitions(offset: number): readonly ts.DefinitionInfo[] {
        try { return this._service.getDefinitionAtPosition(VIRTUAL_FILENAME, offset) ?? []; }
        catch { return []; }
    }

    getReferences(offset: number): readonly ts.ReferenceEntry[] {
        try { return this._service.getReferencesAtPosition(VIRTUAL_FILENAME, offset) ?? []; }
        catch { return []; }
    }

    getDocumentHighlights(offset: number): readonly ts.DocumentHighlights[] {
        try {
            return this._service.getDocumentHighlights(
                VIRTUAL_FILENAME, offset, [VIRTUAL_FILENAME],
            ) ?? [];
        } catch { return []; }
    }

    /**
     * Quick fixes TypeScript offers for `errorCodes` over the given span.
     *
     * The empty formatting options and preferences are deliberate: every fix
     * that matters for a Classic ASP page rewrites an identifier in place
     * ("did you mean getElementById?"), so there is no inserted block whose
     * indentation would need to match the file.
     */
    getCodeFixes(
        start:      number,
        end:        number,
        errorCodes: number[],
    ): readonly ts.CodeFixAction[] {
        try {
            return this._service.getCodeFixesAtPosition(
                VIRTUAL_FILENAME, start, end, errorCodes, {}, {},
            ) ?? [];
        } catch { return []; }
    }

    getRenameInfo(offset: number): ts.RenameInfo | undefined {
        try {
            return this._service.getRenameInfo(VIRTUAL_FILENAME, offset, {
                providePrefixAndSuffixTextForRename: false,
            });
        } catch { return undefined; }
    }

    findRenameLocations(offset: number): readonly ts.RenameLocation[] {
        try {
            return this._service.findRenameLocations(
                VIRTUAL_FILENAME, offset, false, false, { providePrefixAndSuffixTextForRename: false },
            ) ?? [];
        } catch { return []; }
    }

    getSignatureHelp(offset: number): ts.SignatureHelpItems | undefined {
        try { return this._service.getSignatureHelpItems(VIRTUAL_FILENAME, offset, undefined) ?? undefined; }
        catch { return undefined; }
    }

    getSyntacticDiagnostics(): ts.DiagnosticWithLocation[] {
        try { return this._service.getSyntacticDiagnostics(VIRTUAL_FILENAME) ?? []; }
        catch { return []; }
    }

    getSemanticDiagnostics(): ts.Diagnostic[] {
        try { return this._service.getSemanticDiagnostics(VIRTUAL_FILENAME) ?? []; }
        catch { return []; }
    }

    getEncodedSemanticClassifications(start: number, length: number): ts.Classifications {
        try {
            return this._service.getEncodedSemanticClassifications(
                VIRTUAL_FILENAME, { start, length },
                typescript().SemanticClassificationFormat.TwentyTwenty
            );
        } catch {
            return { spans: [], endOfLineState: typescript().EndOfLineState.None };
        }
    }

    dispose(): void { this._service.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────
let _service: JsLanguageService | undefined;

export function getJsLanguageService(): JsLanguageService {
    if (!_service) {
        try { _service = new JsLanguageService(); }
        catch (err) {
            console.error('[ASP] Failed to create JsLanguageService:', err);
            throw err;
        }
    }
    return _service;
}

/** The JS service with the virtual file for a caret in a <script> block loaded. */
export interface JsQuery {
    svc:            JsLanguageService;
    /** The virtual file, for reading the characters around the caret. */
    virtualContent: string;
    /** The caret as an offset in the virtual file. */
    virtualOffset:  number;
    preambleLength: number;
}

/**
 * What every JavaScript feature does first: check the offset is in a
 * <script> block, build the virtual file around it, and load that into the
 * language service. Undefined when the offset is not JavaScript.
 */
export function prepareJsQuery(fullText: string, offset: number): JsQuery | undefined {
    if (getZone(fullText, offset) !== 'js') { return undefined; }

    const { virtualContent, isInScript, preambleLength } = buildVirtualJsContent(fullText, offset);
    if (!isInScript) { return undefined; }

    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);
    return { svc, virtualContent, virtualOffset: offset + preambleLength, preambleLength };
}

export function disposeJsLanguageService(): void {
    _service?.dispose();
    _service = undefined;
}
