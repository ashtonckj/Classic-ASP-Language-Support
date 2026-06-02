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
import * as fs from 'fs';
import * as ts from 'typescript';
import * as vscode from 'vscode';

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
// getJsRanges
//
// Returns the character offsets of every JavaScript <script> block in `content`.
// `start` is the index of the first character after `>`, `end` is the index of
// the `<` that begins `</script>` — so JS content is `content.slice(start, end)`.
//
// Blocks with a non-JS `type` attribute (e.g. `type="text/html"`) and blocks
// with `language="vbscript"` are excluded.
//
// Shared by jsDiagnosticsProvider, jsSemanticProvider, jsDocumentSymbolProvider,
// and jsCompletionProvider to avoid duplicating the same regex logic in each file.
// ─────────────────────────────────────────────────────────────────────────────
export function getJsRanges(content: string): Array<{ start: number; end: number }> {

    // Pre-blank HTML comments and ASP blocks so any <script> tags inside them
    // are invisible to the search below. Newlines are preserved so all offsets
    // into `content` remain valid — only the non-newline characters are replaced
    // with spaces in the search copy.
    const searchable = content
        .replace(/<!--[\s\S]*?-->/g, m => blankNonNewlines(m))
        .replace(/<%[\s\S]*?%>/g,    m => blankNonNewlines(m));
    const searchableLower = searchable.toLowerCase();

    /**
     * Find the index of the closing '>' of a <script> opening tag, starting
     * at `from`. Works directly on `searchable` where ASP blocks are already
     * blanked, so a stray '>' inside a block can't fool it.
     */
    function findTagClose(from: number): number {
        let i = from;
        let inQuote: string | null = null;

        while (i < searchable.length) {
            const ch = searchable[i];
            if (inQuote) {
                if (ch === inQuote) { inQuote = null; }
                i++;
                continue;
            }
            if (ch === '"' || ch === "'") {
                inQuote = ch;
                i++;
                continue;
            }
            if (ch === '>') { return i; }
            i++;
        }
        return -1;
    }

    /**
     * Scans JS source text (from `start` in `content`) character by character,
     * tracking string and line-comment state, and returns the absolute offset of
     * the first `</script` that is NOT inside a string literal or line comment.
     *
     * This prevents `var s = '</script>'` from being mistaken for the real closing
     * tag of the surrounding <script> block.
     *
     * Template literals (backticks) are also tracked. Nested template expressions
     * `${}` are intentionally not recursed into — the heuristic is good enough for
     * the single-file ASP use-case and avoids a full parser.
     */
    function findScriptClose(start: number): number {
        let i = start;
        let inStr = false;
        let strChar = '';
        let inLine = false;   // inside a // line comment

        while (i < content.length) {
            // ── line comment ─────────────────────────────────────────────────
            if (inLine) {
                if (content[i] === '\n') { inLine = false; }
                i++;
                continue;
            }

            // ── inside a string literal ───────────────────────────────────
            if (inStr) {
                if (content[i] === '\\' && strChar !== '`') {
                    i += 2;   // skip escaped character
                    continue;
                }
                if (content[i] === strChar) { inStr = false; }
                i++;
                continue;
            }

            // ── outside any string/comment ────────────────────────────────
            // Detect start of line comment
            if (content[i] === '/' && content[i + 1] === '/') {
                inLine = true;
                i += 2;
                continue;
            }
            // Detect start of block comment — scan to */
            if (content[i] === '/' && content[i + 1] === '*') {
                const end = content.indexOf('*/', i + 2);
                i = end === -1 ? content.length : end + 2;
                continue;
            }
            // Detect start of string
            if (content[i] === '"' || content[i] === "'" || content[i] === '`') {
                inStr   = true;
                strChar = content[i];
                i++;
                continue;
            }
            // Detect </script>  (case-insensitive, optional whitespace before >)
            if (content[i] === '<' && content[i + 1] === '/') {
                const slice = content.slice(i, i + 9).toLowerCase();
                if (slice.startsWith('</script')) {
                    // Make sure it's </script> or </script  (not </scriptx)
                    const ch = content[i + 8];
                    if (ch === '>' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
                        return i;
                    }
                }
            }
            i++;
        }
        return -1;
    }

    const ranges: Array<{ start: number; end: number }> = [];
    let searchFrom = 0;

    while (true) {
        const scriptOpen = searchableLower.indexOf('<script', searchFrom);
        if (scriptOpen === -1) { break; }

        const charAfter = searchable[scriptOpen + 7];
        if (charAfter !== '>' && charAfter !== ' ' && charAfter !== '\t' &&
            charAfter !== '\n' && charAfter !== '\r' && charAfter !== '/') {
            searchFrom = scriptOpen + 7;
            continue;
        }

        const scriptTagEnd = findTagClose(scriptOpen + 7);
        if (scriptTagEnd === -1) { break; }

        const attrs = searchable.slice(scriptOpen + 7, scriptTagEnd);

        const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
        if (typeMatch && !/javascript|module/i.test(typeMatch[1])) {
            searchFrom = scriptTagEnd + 1;
            continue;
        }
        if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs)) {
            searchFrom = scriptTagEnd + 1;
            continue;
        }

        const tagEnd   = scriptTagEnd + 1;
        const closeIdx = findScriptClose(tagEnd);
        const end      = closeIdx === -1 ? content.length : closeIdx;

        ranges.push({ start: tagEnd, end });
        searchFrom = end;
    }

    return ranges;
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
function collectVbsConsts(content: string): Map<string, string> {
    const seen = new Set<string>();
    const consts = new Map<string, string>(); // original-cased name → TS type

    // Only statement blocks — not expression blocks
    const aspRegex = /<%(?!=)([\s\S]*?)%>/g;
    let m: RegExpExecArray | null;
    while ((m = aspRegex.exec(content)) !== null) {
        const block = m[1].replace(/ _\r?\n/g, ' ');

        // Matches:  Const NAME = <value>
        // The value ends at end-of-line (or colon for multi-statement lines).
        const constRegex = /^\s*Const\s+([A-Za-z_]\w*)\s*=\s*([^\r\n:]+)/gim;
        let c: RegExpExecArray | null;
        while ((c = constRegex.exec(block)) !== null) {
            const name = c[1];
            const key = name.toLowerCase();
            if (seen.has(key)) { continue; }
            seen.add(key);
            consts.set(name, inferVbsConstType(c[2]));
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

/**
 * Builds the preamble and the expression-sentinel map for the virtual file.
 * @param content   Raw ASP source text.
 * @param jsRanges  Pre-computed JS script ranges (from getJsRanges).
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
function substituteAspBlock(asp: string, sentinel: string | undefined): string {
    const isExpression = asp.startsWith('<%=');
    const token        = isExpression ? (sentinel ?? '_asp') : '_asp';

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
    const jsRanges = getJsRanges(content);
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
function makeBrowserCompilerOptions(): ts.CompilerOptions {
    return {
        target:  ts.ScriptTarget.ES2020,
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
export class JsLanguageService implements vscode.Disposable {
    private readonly _service:         ts.LanguageService;
    private readonly _compilerOptions: ts.CompilerOptions;
    private          _content:         string = '';
    private          _version:         number = 0;
    private readonly _aspDomTypes:     string;

    constructor(extensionPath?: string) {
        this._compilerOptions = makeBrowserCompilerOptions();
        const libDir = path.dirname(ts.getDefaultLibFilePath(this._compilerOptions));

        this._aspDomTypes = extensionPath
            ? this.loadAspDomTypes(extensionPath)
            : this.getInlineAspDomTypes();

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

    private loadAspDomTypes(extensionPath: string): string {
        try {
            const typesPath = path.join(extensionPath, 'utils', 'asp-dom.d.ts');
            if (fs.existsSync(typesPath)) {
                return fs.readFileSync(typesPath, 'utf8');
            }
        } catch (err) {
            console.warn('[ASP] Failed to load asp-dom.d.ts, using inline definitions:', err);
        }
        return this.getInlineAspDomTypes();
    }

    private getInlineAspDomTypes(): string {
        return `
    // Augment the standard HTMLElement interface directly so that Classic ASP
    // inline scripts can call element-specific members (.submit(), .value,
    // .selectedIndex, etc.) without type errors — exactly like plain .html files,
    // where the HTML language service never enforces specific element subtypes.
    // All members are optional so existing HTMLElement usage is unaffected.
    // The Document interface is intentionally left untouched; getElementById /
    // querySelector already return HTMLElement | null in lib.dom.d.ts.
    interface HTMLElement {

        // ── HTMLFormElement ───────────────────────────────────────────────────
        submit?():          void;
        reset?():           void;
        checkValidity?():   boolean;
        reportValidity?():  boolean;
        elements?:          HTMLFormControlsCollection;
        action?:            string;
        method?:            string;
        enctype?:           string;
        encoding?:          string;
        noValidate?:        boolean;

        // ── HTMLInputElement / HTMLTextAreaElement ────────────────────────────
        // value is string|number to stay compatible with HTMLLIElement /
        // HTMLMeterElement / HTMLProgressElement which declare value as number.
        value?:             string | number;
        defaultValue?:      string;
        checked?:           boolean;
        defaultChecked?:    boolean;
        indeterminate?:     boolean;
        placeholder?:       string;
        readOnly?:          boolean;
        required?:          boolean;
        maxLength?:         number;
        minLength?:         number;
        // max / min are string|number: string on input[type=date/number], number on HTMLMeterElement.
        max?:               string | number;
        min?:               string | number;
        step?:              string;
        pattern?:           string;
        multiple?:          boolean;
        accept?:            string;
        files?:             FileList | null;
        selectionStart?:    number | null;
        selectionEnd?:      number | null;
        // readonly: HTMLTextAreaElement and others declare both readonly.
        readonly validity?:          ValidityState;
        readonly validationMessage?: string;
        select?():            void;
        setSelectionRange?(start: number | null, end: number | null, direction?: string): void;
        setCustomValidity?(error: string): void;

        // ── HTMLSelectElement ─────────────────────────────────────────────────
        selectedIndex?:   number;
        // readonly HTMLCollectionOf<HTMLOptionElement>: matches HTMLDataListElement exactly.
        // HTMLSelectElement.options (HTMLOptionsCollection) extends HTMLCollectionOf so it's compatible.
        readonly options?:         HTMLCollectionOf<HTMLOptionElement>;
        selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
        // size is string|number: number on HTMLSelectElement, string on HTMLFontElement/HTMLHRElement.
        size?:            string | number;

        // ── HTMLOptionElement ─────────────────────────────────────────────────
        selected?:  boolean;
        label?:     string;
        text?:      string;
        index?:     number;

        // ── HTMLImageElement ──────────────────────────────────────────────────
        naturalWidth?:  number;
        naturalHeight?: number;
        complete?:      boolean;
        currentSrc?:    string;

        // ── HTMLTableElement ──────────────────────────────────────────────────
        insertRow?(index?: number):  HTMLTableRowElement;
        deleteRow?(index: number):   void;
        createTHead?():              HTMLTableSectionElement;
        createTFoot?():              HTMLTableSectionElement;
        createTBody?():              HTMLTableSectionElement;
        deleteTHead?():              void;
        deleteTFoot?():              void;
        // string | number | HTMLCollectionOf<...>:
        //   HTMLFrameSetElement → string, HTMLTextAreaElement → number, HTMLTableElement → HTMLCollectionOf
        rows?:                       string | number | HTMLCollectionOf<HTMLTableRowElement>;
        tHead?:                      HTMLTableSectionElement | null;
        tFoot?:                      HTMLTableSectionElement | null;
        tBodies?:                    HTMLCollectionOf<HTMLTableSectionElement>;
        caption?:                    HTMLTableCaptionElement | null;

        // ── HTMLTableRowElement ───────────────────────────────────────────────
        insertCell?(index?: number): HTMLTableCellElement;
        deleteCell?(index: number):  void;
        cells?:                      HTMLCollectionOf<HTMLTableCellElement>;
        rowIndex?:                   number;
        sectionRowIndex?:            number;

        // ── HTMLTableCellElement ──────────────────────────────────────────────
        colSpan?:   number;
        rowSpan?:   number;
        cellIndex?: number;
        abbr?:      string;
        scope?:     string;

        // ── HTMLMediaElement (video / audio) ──────────────────────────────────
        play?():    Promise<void>;
        pause?():   void;
        canPlayType?(type: string): CanPlayTypeResult;
        paused?:    boolean;
        ended?:     boolean;
        volume?:    number;
        currentTime?: number;
        duration?:  number;

        // ── HTMLCanvasElement ─────────────────────────────────────────────────
        toDataURL?(type?: string, quality?: any): string;
        toBlob?(callback: BlobCallback, type?: string, quality?: any): void;

        // ── HTMLIFrameElement ─────────────────────────────────────────────────
        contentDocument?: Document | null;
        contentWindow?:   WindowProxy | null;

        // ── HTMLButtonElement ─────────────────────────────────────────────────
        formAction?:     string;
        formMethod?:     string;
        formTarget?:     string;
        formNoValidate?: boolean;
    }
    `;
    }

    updateContent(content: string): void {
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
                triggerCharacter:                         trigger as ts.CompletionsTriggerCharacter | undefined,
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
                ts.SemanticClassificationFormat.TwentyTwenty
            );
        } catch {
            return { spans: [], endOfLineState: ts.EndOfLineState.None };
        }
    }

    dispose(): void { this._service.dispose(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────
let _service: JsLanguageService | undefined;
let _extensionPath: string | undefined;

export function initializeJsLanguageService(extensionPath: string): void {
    _extensionPath = extensionPath;
}

export function getJsLanguageService(): JsLanguageService {
    if (!_service) {
        try { _service = new JsLanguageService(_extensionPath); }
        catch (err) {
            console.error('[ASP] Failed to create JsLanguageService:', err);
            throw err;
        }
    }
    return _service;
}

export function disposeJsLanguageService(): void {
    _service?.dispose();
    _service = undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// ts.ScriptElementKind → vscode.CompletionItemKind
// ─────────────────────────────────────────────────────────────────────────────
export function tsKindToVsKind(kind: string): vscode.CompletionItemKind {
    switch (kind) {
        case ts.ScriptElementKind.functionElement:
        case ts.ScriptElementKind.localFunctionElement:
            return vscode.CompletionItemKind.Function;
        case ts.ScriptElementKind.memberFunctionElement:
        case ts.ScriptElementKind.callSignatureElement:
        case ts.ScriptElementKind.constructSignatureElement:
            return vscode.CompletionItemKind.Method;
        case ts.ScriptElementKind.variableElement:
        case ts.ScriptElementKind.localVariableElement:
        case ts.ScriptElementKind.letElement:
        case ts.ScriptElementKind.constElement:
            return vscode.CompletionItemKind.Variable;
        case ts.ScriptElementKind.classElement:
        case ts.ScriptElementKind.localClassElement:
            return vscode.CompletionItemKind.Class;
        case ts.ScriptElementKind.interfaceElement:
            return vscode.CompletionItemKind.Interface;
        case ts.ScriptElementKind.enumElement:
            return vscode.CompletionItemKind.Enum;
        case ts.ScriptElementKind.enumMemberElement:
            return vscode.CompletionItemKind.EnumMember;
        case ts.ScriptElementKind.moduleElement:
        case ts.ScriptElementKind.externalModuleName:
            return vscode.CompletionItemKind.Module;
        case ts.ScriptElementKind.memberVariableElement:
        case ts.ScriptElementKind.memberGetAccessorElement:
        case ts.ScriptElementKind.memberSetAccessorElement:
            return vscode.CompletionItemKind.Field;
        case ts.ScriptElementKind.typeElement:
        case ts.ScriptElementKind.typeParameterElement:
            return vscode.CompletionItemKind.TypeParameter;
        case ts.ScriptElementKind.keyword:
            return vscode.CompletionItemKind.Keyword;
        case ts.ScriptElementKind.string:
            return vscode.CompletionItemKind.Value;
        default:
            return vscode.CompletionItemKind.Property;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ts.DiagnosticCategory → vscode.DiagnosticSeverity
// ─────────────────────────────────────────────────────────────────────────────
export function tsSeverityToVs(category: ts.DiagnosticCategory): vscode.DiagnosticSeverity {
    switch (category) {
        case ts.DiagnosticCategory.Error:      return vscode.DiagnosticSeverity.Error;
        case ts.DiagnosticCategory.Warning:    return vscode.DiagnosticSeverity.Warning;
        case ts.DiagnosticCategory.Suggestion: return vscode.DiagnosticSeverity.Hint;
        case ts.DiagnosticCategory.Message:    return vscode.DiagnosticSeverity.Information;
        default:                               return vscode.DiagnosticSeverity.Warning;
    }
}