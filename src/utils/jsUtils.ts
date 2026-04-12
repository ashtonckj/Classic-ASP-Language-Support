/**
 * jsUtils.ts  (utils/)
 *
 * Embedded JavaScript support for .asp files — TypeScript Language Service wrapper.
 *
 * Maintains a single JsLanguageService singleton that is shared across all JS
 * providers (completion, hover, diagnostics, semantic tokens, document symbols).
 * The virtual file 'asp-embedded.js' is updated with blanked content before each
 * query so offset positions stay exact across the whole document.
 */

import * as path   from 'path';
import * as fs     from 'fs';
import * as ts     from 'typescript';
import * as vscode from 'vscode';
import { getZone } from './aspUtils';

export const VIRTUAL_FILENAME = 'asp-embedded.js';
export const ASP_DOM_TYPES_FILENAME = 'asp-dom.d.ts';

// ─────────────────────────────────────────────────────────────────────────────
// buildVirtualJsContent
//
// Locates every JS <script>…</script> block in the document. Everything outside
// those blocks is replaced with spaces (newlines preserved) so TS offset
// positions remain valid for the whole file. ASP blocks inside script zones
// are also blanked.
// ─────────────────────────────────────────────────────────────────────────────
export interface VirtualJsResult {
    virtualContent: string;
    isInScript:     boolean;
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
 * Shared by jsDiagnosticsProvider, jsSemanticProvider, and jsDocumentSymbolProvider
 * to avoid duplicating the same regex logic in each file.
 */
export function getJsRanges(content: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    const re = /<script(\s[^>]*)?>/gi;
    let m: RegExpExecArray | null;

    while ((m = re.exec(content)) !== null) {
        const attrs  = m[1] ?? '';
        const tagEnd = m.index + m[0].length;

        const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
        if (typeMatch && !/javascript|module/i.test(typeMatch[1])) { continue; }
        if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs))      { continue; }

        const rest     = content.slice(tagEnd);
        const closeIdx = rest.search(/<\/script\s*>/i);
        const end      = closeIdx === -1 ? content.length : tagEnd + closeIdx;

        ranges.push({ start: tagEnd, end });
        re.lastIndex = end;
    }

    return ranges;
}

export function buildVirtualJsContent(
    content: string,
    offset:  number
): VirtualJsResult {
    const jsRanges = getJsRanges(content);

    const isInScript = jsRanges.some(r => offset >= r.start && offset <= r.end);

    let out  = '';
    let prev = 0;
    for (const r of jsRanges) {
        out += blankNonNewlines(content.slice(prev, r.start));
        out += content.slice(r.start, r.end).replace(/<%[\s\S]*?%>/g, asp => blankNonNewlines(asp));
        prev = r.end;
    }
    out += blankNonNewlines(content.slice(prev));

    return { virtualContent: out, isInScript };
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
// Zone helpers
// ─────────────────────────────────────────────────────────────────────────────
export function isInJsZone(document: vscode.TextDocument, position: vscode.Position): boolean {
    return getZone(document.getText(), document.offsetAt(position)) === 'js';
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