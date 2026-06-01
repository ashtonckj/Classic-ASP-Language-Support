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
 * ── ASP → JS Projection strategy (any-typed variable projection) ────────────
 *
 * The core problem with fake-literal placeholders ("", 0, [], false) was that
 * TypeScript narrows those to specific types, causing TS2367 errors when they
 * are later compared to other values in JS `if` / `switch` / `===` expressions.
 *
 * The solution is a TWO-PASS system:
 *
 *   PASS 1 — Preamble generation (runs over the whole document)
 *     • Every VBScript variable name found in ANY <% ... %> statement block is
 *       collected and declared as `var _asp_<name>: any` in a preamble prepended
 *       to the top of the virtual file.
 *     • Every expression slot <%= expr %> inside a JS range gets a sanitised
 *       sentinel name `_aspo_<expr>`, also declared as `var _aspo_<expr>: any`.
 *     • Declaring with type `any` prevents TypeScript from narrowing these to
 *       literal types regardless of how the JS code uses them.
 *
 *   PASS 2 — Inline substitution (offset-preserving)
 *     • Statement blocks  <% code %>   →  block comment ... (same shape)
 *     • Expression blocks <%= expr %>  →  _aspo_<expr>  padded to the same
 *       character width, so all downstream source positions stay valid.
 *
 * EXAMPLES
 *   Source (.asp):
 *     <%
 *       userId = Session("id")
 *       count  = RS("total")
 *     %>
 *     <script>
 *       var x = <%= userId %>;
 *       if (x === "hello") { }        // ← no TS2367: x is any
 *       if (<%= count %> > 0) { }     // ← no TS2367: _aspo_count is any
 *     </script>
 *
 *   Virtual JS produced:
 *     var _asp_userId: any;           // ← preamble declarations
 *     var _asp_count: any;
 *     var _aspo_userId: any;
 *     var _aspo_count: any;
 *
 *     (blanked HTML)
 *     (blanked script tag)
 *       var x = _aspo_userId ;        // ← inline substitution, same width
 *       if (x === "hello") { }
 *       if (_aspo_count   > 0) { }
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

export const VIRTUAL_FILENAME = 'asp-embedded.js';
export const ASP_DOM_TYPES_FILENAME = 'asp-dom.d.ts';

// ─────────────────────────────────────────────────────────────────────────────
// buildVirtualJsContent
//
// Locates every JS <script>…</script> block in the document. Everything outside
// those blocks is replaced with spaces (newlines preserved) so TS offset
// positions remain valid for the whole file. ASP blocks inside script zones
// are projected to any-typed variable references (see file-level comment).
// ─────────────────────────────────────────────────────────────────────────────
export interface VirtualJsResult {
    virtualContent: string;
    isInScript: boolean;
    /**
     * Number of characters in the generated preamble that was prepended to the
     * virtual content.  Every provider MUST:
     *   • ADD    preambleLength to cursor/hover/offset before querying the TS service.
     *   • SUBTRACT preambleLength from diagnostic/token/span positions before
     *     reporting back to VS Code (document.positionAt).
     */
    preambleLength: number;
}

function blankNonNewlines(s: string): string {
    return s.replace(/[^\n]+/g, m => ' '.repeat(m.length));
}

/**
 * Returns the character offsets of every JavaScript <script> block in `content`.
 * `start` is the index of the first character after `>`, `end` is the index of
 * the `<` that begins `</script>` — so JS content is `content.slice(start, end)`.
 *
 * Blocks with a non-JS `type` attribute (e.g. `type="text/html"`) and blocks
 * with `language="vbscript"` are excluded.
 *
 * Shared by jsDiagnosticsProvider, jsSemanticProvider, jsDocumentSymbolProvider,
 * and jsCompletionProvider to avoid duplicating the same regex logic in each file.
 */
export function getJsRanges(content: string): Array<{ start: number; end: number }> {
    const aspRanges: Array<{ start: number; end: number }> = [];
    const aspRegex = /<%[\s\S]*?%>/g;
    let aspM: RegExpExecArray | null;
    while ((aspM = aspRegex.exec(content)) !== null) {
        aspRanges.push({ start: aspM.index, end: aspM.index + aspM[0].length });
    }
    const isInsideAsp = (offset: number): boolean =>
        aspRanges.some(r => offset >= r.start && offset < r.end);

    /**
     * Find the index of the closing '>' of a <script> opening tag, starting
     * at `from`. Unlike a simple indexOf('>'), this skips over any embedded
     * ASP blocks (<%...%>) so that a '>' inside e.g. <%=fn()%> is not
     * mistaken for the end of the tag.
     */
    function findTagClose(from: number): number {
        let i = from;
        while (i < content.length) {
            // If we're at the start of an ASP block, jump past it entirely.
            if (content[i] === '<' && content[i + 1] === '%') {
                const aspEnd = content.indexOf('%>', i);
                if (aspEnd === -1) { return -1; } // malformed — give up
                i = aspEnd + 2;
                continue;
            }
            if (content[i] === '>') { return i; }
            i++;
        }
        return -1;
    }

    const ranges: Array<{ start: number; end: number }> = [];
    let searchFrom = 0;

    while (true) {
        const scriptOpen = content.indexOf('<script', searchFrom);
        if (scriptOpen === -1) { break; }

        // Must be followed by '>' or whitespace (not e.g. '<scriptx')
        const charAfter = content[scriptOpen + 7];
        if (charAfter !== '>' && charAfter !== ' ' && charAfter !== '\t' &&
            charAfter !== '\n' && charAfter !== '\r' && charAfter !== '/') {
            searchFrom = scriptOpen + 7;
            continue;
        }

        if (isInsideAsp(scriptOpen)) {
            searchFrom = scriptOpen + 7;
            continue;
        }

        // Find the real end of the opening tag, skipping over embedded ASP blocks.
        const scriptTagEnd = findTagClose(scriptOpen + 7);
        if (scriptTagEnd === -1) { break; }

        // Extract attributes — but ASP blocks inside them are noise; blank them
        // out temporarily just for attribute parsing.
        const rawAttrs = content.slice(scriptOpen + 7, scriptTagEnd);
        const cleanAttrs = rawAttrs.replace(/<%[\s\S]*?%>/g, m => ' '.repeat(m.length));

        const typeMatch = cleanAttrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
        if (typeMatch && !/javascript|module/i.test(typeMatch[1])) {
            searchFrom = scriptTagEnd + 1;
            continue;
        }
        if (/\blanguage\s*=\s*["']vbscript["']/i.test(cleanAttrs)) {
            searchFrom = scriptTagEnd + 1;
            continue;
        }

        const tagEnd = scriptTagEnd + 1; // index of first char after '>'
        const rest     = content.slice(tagEnd);
        const closeIdx = rest.search(/<\/script\s*>/i);
        const end      = closeIdx === -1 ? content.length : tagEnd + closeIdx;

        ranges.push({ start: tagEnd, end });
        searchFrom = end;
    }

    return ranges;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 1 — preamble builder
//
// Scans the entire document and collects:
//   a) Every VBScript variable name assigned inside any <% ... %> block
//      → declared as `var _asp_<name>: any` in the preamble.
//   b) Every <%= expr %> expression block inside a JS <script> range
//      → assigned a sanitised sentinel `_aspo_<expr>`, also declared as `any`.
//
// Returns:
//   preamble        — the `var _asp_*/var _aspo_*: any;` block to prepend
//   exprSentinels   — Map<aspBlock start-offset → sentinel name> used by pass 2
// ─────────────────────────────────────────────────────────────────────────────

interface PreambleResult {
    preamble: string;                       // e.g. "var _asp_userId: any;\nvar _aspo_userId: any;\n"
    exprSentinels: Map<number, string>;     // aspBlock start-offset → sentinel name
}

/**
 * JavaScript reserved words and common built-ins that must never appear in the
 * preamble as `var <name>: any` declarations — doing so causes TS parse errors
 * (e.g. `var If: any` or `var Then: any` from VBScript If/Then comparisons).
 *
 * VBScript keywords that look like assignments (e.g. `If x = y Then`) would be
 * matched by the assignment regex and incorrectly added to the preamble without
 * this guard.
 */
const JS_RESERVED = new Set([
    // JS reserved words
    'break','case','catch','class','const','continue','debugger','default',
    'delete','do','else','export','extends','finally','for','function','if',
    'import','in','instanceof','let','new','return','static','super','switch',
    'this','throw','try','typeof','var','void','while','with','yield',
    // Strict mode / future reserved
    'enum','implements','interface','package','private','protected','public',
    // Common globals we never want to shadow
    'undefined','null','true','false','NaN','Infinity','arguments',
    'window','document','console','alert','confirm','prompt',
]);

/**
 * Collects all VBScript identifier names that are assigned (=) inside any
 * <%  ... %> statement block in `content`. Names are lowercased for
 * deduplication, but the original casing of the first occurrence is kept.
 */
function collectVbsVarNames(content: string): string[] {
    const seen = new Set<string>();
    const names: string[] = [];

    // <%(?!=) matches <% but NOT <%= (expression blocks, e.g. <%=variable%>)
    const aspRegex = /<%(?!=)([\s\S]*?)%>/g;
    let m: RegExpExecArray | null;
    while ((m = aspRegex.exec(content)) !== null) {
        // Collapse VBScript line continuations (" _\n") before pattern matching,
        // otherwise continued lines (e.g. `testing = 10 Then`) are mistaken for assignments.
        const block = m[1].replace(/ _\r?\n/g, ' ');

        // Matches assignments:  [Set|Const] identifier = ...
        const assignedRegex = /^\s*(?:Set|Const)?\s*([A-Za-z_]\w*)\s*=/gm;
        let assignedVar: RegExpExecArray | null;
        while ((assignedVar = assignedRegex.exec(block)) !== null) {
            const raw = assignedVar[1];
            if (JS_RESERVED.has(raw.toLowerCase())) { continue; }
            const key = raw.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                names.push(raw);
            }
        }

        // Matches Dim declarations, including comma-separated lists:  Dim foo, bar, baz
        const declaredRegex = /^\s*Dim\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/gim;
        let declaredVar: RegExpExecArray | null;
        while ((declaredVar = declaredRegex.exec(block)) !== null) {
            const raw = declaredVar[1];
            if (JS_RESERVED.has(raw.toLowerCase())) { continue; }
            const key = raw.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                names.push(raw);
            }
        }
    }
    return names;
}

/**
 * Collects all ASP expression blocks (<%= ... %>) that fall within the given
 * JS ranges, and maps their absolute offset to a sanitised sentinel name.
 */
function collectExprSentinels(content: string, jsRanges: Array<{ start: number; end: number }>): Map<number, string> {
    const seen = new Set<string>();
    const exprSentinels = new Map<number, string>();

    for (const range of jsRanges) {
        const js = content.slice(range.start, range.end);
        const aspRegex = /<%=\s*([\s\S]*?)\s*%>/g;
        let sentinelVar: RegExpExecArray | null;
        while ((sentinelVar = aspRegex.exec(js)) !== null) {
            const raw = sentinelVar[1];
            if (JS_RESERVED.has(raw.toLowerCase())) { continue; }
            const absOffset = range.start + sentinelVar.index;
            const key = raw.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                exprSentinels.set(absOffset, raw.replace(/\s+/g, '_'));
            }
        }
    }

    return exprSentinels;
}

/**
 * Builds the preamble and the expression-sentinel map for the virtual file.
 * @param content   Raw ASP source text.
 * @param jsRanges  Pre-computed JS script ranges (from getJsRanges).
 */
function buildPreamble(content: string, jsRanges: Array<{ start: number; end: number }>): PreambleResult {
    const vbsNames = collectVbsVarNames(content);
    const exprSentinels = collectExprSentinels(content, jsRanges);

    const lines: string[] = [
        '// [asp-projection] any-typed preamble — auto-generated, do not edit',
    ];

    for (const name of vbsNames) {
        lines.push(`var _asp_${name}: any;`);
    }
    for (const sentinel of exprSentinels.values()) {
        lines.push(`var _aspo_${sentinel}: any;`);
    }

    lines.push('');
    const preamble = lines.join('\n') + '\n';

    return { preamble, exprSentinels };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2 — inline substitution
//
// Replaces each ASP block in the JS body with an offset-preserving token:
//   Statement block  <% code %>    →  /* code */     (block comment, same shape)
//   Expression block <%= expr %>   →  _aspo_<expr>   (sentinel name, space-padded)
//
// The sentinel name is looked up from the map built in pass 1. If a block
// is missing from the map (e.g. an expression block outside any JS range),
// a bare `0` fallback is used — harmless since it won't be seen by JS.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replaces a single ASP block with its offset-preserving virtual-JS form.
 *
 * @param asp       The raw ASP block text, e.g. `<%= userId %>`.
 * @param sentinel  For expression blocks, the pre-assigned _aspo_<expr> name.
 *                  Pass `undefined` for statement blocks (they become comments).
 */
function substituteAspBlock(asp: string, sentinel: string | undefined): string {
    const isExpression = asp.startsWith('<%=');

    // ── Statement block: becomes a /* … */ comment of the same shape ─────────
    if (!isExpression) {
        const blanked = blankNonNewlines(asp);
        const firstNonNl = blanked.indexOf(' ');
        if (firstNonNl === -1 || blanked.length < 4) {
            return blanked;
        }
        let chars = blanked.split('');
        chars[firstNonNl] = '/';
        chars[firstNonNl + 1] = '*';
        let lastNonNl = chars.length - 1;
        while (lastNonNl > firstNonNl && chars[lastNonNl] === '\n') { lastNonNl--; }
        if (lastNonNl > firstNonNl + 1) {
            chars[lastNonNl - 1] = '*';
            chars[lastNonNl] = '/';
        }
        return chars.join('');
    }

    // ── Expression block: replaced with sentinel name (or fallback) ───────────
    const blanked = blankNonNewlines(asp);
    const totalLen = blanked.length;
    let leadingNewlines = 0;
    while (leadingNewlines < totalLen && blanked[leadingNewlines] === '\n') {
        leadingNewlines++;
    }
    const available = totalLen - leadingNewlines;

    const name = sentinel ?? '(undefined as any)';
    const token = name.length <= available
        ? name.padEnd(available, ' ').slice(0, available)
        : '0'.padEnd(available, ' ').slice(0, available);

    return blanked.slice(0, leadingNewlines) + token;
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
    console.log(preamble + body);
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

        // Load custom DOM type definitions
        // Try to load from extension path first, fall back to inline definitions
        this._aspDomTypes = extensionPath
            ? this.loadAspDomTypes(extensionPath)
            : this.getInlineAspDomTypes();

        const self   = this;

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
            readDirectory:          ts.sys.readDirectory.bind(ts.sys),
            directoryExists:        ts.sys.directoryExists.bind(ts.sys),
            getDirectories:         ts.sys.getDirectories.bind(ts.sys),
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