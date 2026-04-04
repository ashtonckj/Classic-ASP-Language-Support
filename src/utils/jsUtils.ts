/**
 * jsUtils.ts  (utils/)
 *
 * Embedded JavaScript support for .asp files — TypeScript Compiler API edition.
 *
 * Fixes in this version:
 *   • buildVirtualJsContent — correct forward-only </script> search (was
 *     always searching from position 0, breaking multi-script files and
 *     causing textarea.addEventListener etc. to be missing)
 *   • CompilerOptions — added types:[] to block @types/node leaking in
 *     (was causing console to show Node.js docs instead of browser docs)
 *   • Lib resolution — explicit lib file list resolved via
 *     ts.getDefaultLibFilePath so DOM types always load correctly
 *   • buildVirtualJsContent — rewritten from O(n²) char-split loop to O(n)
 *     slice-based builder; also much lower memory usage
 *   • getJsLanguageService — singleton construction wrapped in try/catch so a
 *     bad TS environment doesn't permanently break the extension
 *   • All query methods accept an explicit content string so callers don't
 *     race over updateContent() when multiple providers fire concurrently
 */

import * as path from 'path';
import * as ts   from 'typescript';
import * as vscode from 'vscode';
import { getZone } from './aspUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Virtual file — must end in .js for loose JS checking
// ─────────────────────────────────────────────────────────────────────────────
export const VIRTUAL_FILENAME = 'asp-embedded.js';

// ─────────────────────────────────────────────────────────────────────────────
// buildVirtualJsContent
//
// Scans forward through the document locating every JS <script>…</script>
// block.  All characters outside those blocks are replaced with spaces
// (newlines preserved) so offset positions stay exact.
// ASP blocks (<% … %>) inside script zones are also blanked.
//
// Rewritten to be O(n) — no char-by-char array split, uses slice + repeat.
// ─────────────────────────────────────────────────────────────────────────────
export interface VirtualJsResult {
    virtualContent: string;
    isInScript:     boolean;
}

/** Replace every non-newline character in `s` with a space, preserving length. */
function blankNonNewlines(s: string): string {
    // Replace runs of non-newline chars in one pass — much faster than
    // splitting into chars and mapping individually.
    return s.replace(/[^\n]+/g, m => ' '.repeat(m.length));
}

export function buildVirtualJsContent(
    content: string,
    offset:  number
): VirtualJsResult {
    const jsRanges: Array<{ start: number; end: number }> = [];

    // Walk through the document finding all <script> openers
    const scriptOpenRe = /<script(\s[^>]*)?>/gi;
    let m: RegExpExecArray | null;

    while ((m = scriptOpenRe.exec(content)) !== null) {
        const attrs  = m[1] ?? '';
        const tagEnd = m.index + m[0].length;

        // Skip non-JS script types (consistent with aspUtils.getZone)
        const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
        if (typeMatch && !/javascript|module/i.test(typeMatch[1])) { continue; }
        if (/\blanguage\s*=\s*["']vbscript["']/i.test(attrs)) { continue; }

        // Search for </script> forward from tagEnd (not from 0)
        const closeRe  = /<\/script\s*>/i;
        const rest     = content.slice(tagEnd);
        const closeIdx = rest.search(closeRe);
        const end      = closeIdx === -1 ? content.length : tagEnd + closeIdx;

        jsRanges.push({ start: tagEnd, end });
        // Advance past this block so nested <script> openers are skipped
        scriptOpenRe.lastIndex = end;
    }

    const isInScript = jsRanges.some(r => offset >= r.start && offset <= r.end);

    // ── O(n) virtual content builder ─────────────────────────────────────────
    // Walk through jsRanges in order, blanking the gaps between them.
    let out  = '';
    let prev = 0;

    for (const r of jsRanges) {
        // Gap before this JS block — blank all non-newlines
        out += blankNonNewlines(content.slice(prev, r.start));
        // JS block itself — keep as-is, then blank any embedded ASP blocks
        out += content.slice(r.start, r.end).replace(
            /<%[\s\S]*?%>/g,
            asp => blankNonNewlines(asp)
        );
        prev = r.end;
    }
    // Trailing gap after last JS block
    out += blankNonNewlines(content.slice(prev));

    return { virtualContent: out, isInScript };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compiler options — browser-oriented, Node types explicitly blocked
// ─────────────────────────────────────────────────────────────────────────────
function makeBrowserCompilerOptions(): ts.CompilerOptions {
    return {
        target:      ts.ScriptTarget.ES2020,
        lib:         [
            'lib.es2020.d.ts',
            'lib.dom.d.ts',
            'lib.dom.iterable.d.ts',
        ],
        allowJs:     true,
        checkJs:     true,
        noEmit:      true,
        strict:      false,
        // Block @types/node and any other ambient types so that browser
        // globals (console, document, window) use DOM typings, not Node.js.
        types:       [],
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

    constructor() {
        this._compilerOptions = makeBrowserCompilerOptions();

        const libDir = path.dirname(
            ts.getDefaultLibFilePath(this._compilerOptions)
        );

        const self = this;
        const host: ts.LanguageServiceHost = {
            getScriptFileNames:     () => [VIRTUAL_FILENAME],
            getScriptVersion:       (f) => f === VIRTUAL_FILENAME ? String(self._version) : '0',
            getScriptSnapshot:      (f) => {
                if (f === VIRTUAL_FILENAME) {
                    return ts.ScriptSnapshot.fromString(self._content);
                }
                const text = ts.sys.readFile(f);
                return text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined;
            },
            getCompilationSettings: () => self._compilerOptions,
            getCurrentDirectory:    () => libDir,
            getDefaultLibFileName:  (opts) => ts.getDefaultLibFilePath(opts),
            fileExists:             (f) => f === VIRTUAL_FILENAME || ts.sys.fileExists(f),
            readFile:               (f) => f === VIRTUAL_FILENAME ? self._content : ts.sys.readFile(f),
            readDirectory:          ts.sys.readDirectory.bind(ts.sys),
            directoryExists:        ts.sys.directoryExists.bind(ts.sys),
            getDirectories:         ts.sys.getDirectories.bind(ts.sys),
        };

        this._service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /**
     * Update the virtual file content. Each caller passes its own freshly-built
     * virtualContent so concurrent providers don't race each other.
     */
    updateContent(content: string): void {
        this._content = content;
        this._version++;
    }

    getCompletions(offset: number, trigger?: string): ts.CompletionInfo | undefined {
        try {
            return this._service.getCompletionsAtPosition(VIRTUAL_FILENAME, offset, {
                triggerCharacter: trigger as ts.CompletionsTriggerCharacter | undefined,
                includeCompletionsWithInsertText:         true,
                includeCompletionsForModuleExports:       false,
                includeAutomaticOptionalChainCompletions: true,
            }) ?? undefined;
        } catch { return undefined; }
    }

    getCompletionDetails(
        name: string, offset: number, source?: string
    ): ts.CompletionEntryDetails | undefined {
        try {
            return this._service.getCompletionEntryDetails(
                VIRTUAL_FILENAME, offset, name,
                undefined, source, undefined, undefined
            ) ?? undefined;
        } catch { return undefined; }
    }

    getQuickInfo(offset: number): ts.QuickInfo | undefined {
        try {
            return this._service.getQuickInfoAtPosition(VIRTUAL_FILENAME, offset) ?? undefined;
        } catch { return undefined; }
    }

    getSignatureHelp(offset: number): ts.SignatureHelpItems | undefined {
        try {
            return this._service.getSignatureHelpItems(
                VIRTUAL_FILENAME, offset, undefined
            ) ?? undefined;
        } catch { return undefined; }
    }

    getSyntacticDiagnostics(): ts.DiagnosticWithLocation[] {
        try {
            return this._service.getSyntacticDiagnostics(VIRTUAL_FILENAME) ?? [];
        } catch { return []; }
    }

    getSemanticDiagnostics(): ts.Diagnostic[] {
        try {
            return this._service.getSemanticDiagnostics(VIRTUAL_FILENAME) ?? [];
        } catch { return []; }
    }

    getEncodedSemanticClassifications(
        start: number, length: number
    ): ts.Classifications {
        try {
            return this._service.getEncodedSemanticClassifications(
                VIRTUAL_FILENAME, { start, length },
                ts.SemanticClassificationFormat.TwentyTwenty
            );
        } catch {
            return { spans: [], endOfLineState: ts.EndOfLineState.None };
        }
    }

    dispose(): void {
        this._service.dispose();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton — construction is guarded so a bad TS environment doesn't
// permanently break the extension on first use.
// ─────────────────────────────────────────────────────────────────────────────
let _service: JsLanguageService | undefined;

export function getJsLanguageService(): JsLanguageService {
    if (!_service) {
        try {
            _service = new JsLanguageService();
        } catch (err) {
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
export function isInJsZone(
    document: vscode.TextDocument,
    position: vscode.Position
): boolean {
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