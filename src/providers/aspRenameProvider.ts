import * as vscode from 'vscode';
import { collectAllSymbols, resolveDirectIncludes, readIncludeText } from './includeProvider';
import { getWorkspaceAspFiles } from './aspWorkspaceSymbolProvider';
import { extractSymbols, FileSymbols } from '../utils/symbolParser';
import { getZone, getVbScriptBlockRanges } from '../utils/zoneUtils';
import { VBSCRIPT_KEYWORDS_SET } from '../constants/aspKeywords';
import { isInsideVbStringOrComment } from '../utils/documentHelper';

// ── Scope analysis for rename ────────────────────────────────────────────────

/**
 * Names that are module-level (global) in this file: every Function/Sub/Property
 * and Class name, plus any variable/constant/COM var declared OUTSIDE all
 * function bodies. A name that is NOT in this set, when the caret is inside a
 * function body, is a local (a parameter or an in-body Dim).
 */
function moduleLevelNames(sym: FileSymbols, fns: { line: number; endLine: number }[]): Set<string> {
    const inBody = (line: number) => fns.some(f => f.line <= line && line <= f.endLine);
    const names = new Set<string>();
    for (const f of sym.functions)     { names.add(f.name.toLowerCase()); }
    for (const c of sym.classes)       { names.add(c.name.toLowerCase()); }
    for (const v of sym.variables)     { if (!inBody(v.line)) { names.add(v.name.toLowerCase()); } }
    for (const c of sym.constants)     { if (!inBody(c.line)) { names.add(c.name.toLowerCase()); } }
    for (const cv of sym.comVariables) { if (!inBody(cv.line)) { names.add(cv.name.toLowerCase()); } }
    return names;
}

/**
 * If the caret sits inside a Sub/Function/Property body and `nameLower` is LOCAL
 * to it (a parameter, or not a module-level symbol), return that body's line
 * range — the rename must stay inside it, in the current file only. Otherwise
 * null (the symbol is global; the caller does the wider include-graph search).
 *
 * This is what stops F2 on a local `Dim i` from rewriting every `i` in every
 * function and every file in the workspace.
 */
export function computeLocalRenameScope(
    sym: FileSymbols,
    caretLine: number,
    nameLower: string,
): { line: number; endLine: number } | null {
    const fns = sym.functions.filter(f => f.endLine >= 0);
    let body: FileSymbols['functions'][number] | null = null;
    for (const f of fns) {
        if (f.line <= caretLine && caretLine <= f.endLine && (!body || f.line > body.line)) {
            body = f;
        }
    }
    if (!body) { return null; }

    const isParam  = body.paramNames.some(p => p.toLowerCase() === nameLower);
    const isGlobal = moduleLevelNames(sym, fns).has(nameLower);
    return (isParam || !isGlobal) ? { line: body.line, endLine: body.endLine } : null;
}

/**
 * The procedure bodies in one file where `nameLower` is a DIFFERENT variable from
 * the module-level one, and so must be left alone when the module-level name is
 * renamed. A body qualifies when it declares the name as:
 *   • a parameter          — `Sub Add(total)`
 *   • an explicit Dim      — `Sub Other() : Dim total`
 *   • an explicit Const
 *
 * An implicitly-created name does NOT qualify. In VBScript a bare assignment or a
 * For Each variable inside a procedure resolves to the module-level variable when
 * one exists, rather than declaring a local — so `total = total + 1` inside a Sub
 * really is the outer `total` and must be renamed with it. That is why
 * extractSymbols flags those entries `implicit`.
 *
 * This is the counterpart of computeLocalRenameScope: that one keeps a rename ON a
 * local inside its own body, this one keeps a rename on a GLOBAL out of bodies
 * where the name is shadowed.
 */
export function shadowingBodies(
    sym: FileSymbols,
    nameLower: string,
): { line: number; endLine: number }[] {
    const bodies: { line: number; endLine: number }[] = [];

    for (const fn of sym.functions) {
        if (fn.endLine < 0) { continue; }

        const inBody = (line: number) => fn.line <= line && line <= fn.endLine;
        const shadows =
            fn.paramNames.some(pName => pName.toLowerCase() === nameLower) ||
            sym.variables.some(v => !v.implicit && v.name.toLowerCase() === nameLower && inBody(v.line)) ||
            sym.constants.some(c => c.name.toLowerCase() === nameLower && inBody(c.line));

        if (shadows) { bodies.push({ line: fn.line, endLine: fn.endLine }); }
    }

    return bodies;
}

/**
 * The files that share a SCRIPT SCOPE with `seed`.
 *
 * Classic ASP has exactly two scopes: procedure scope (see computeLocalRenameScope)
 * and script scope. `#include` is textual — IIS splices the file in before the page
 * is compiled — so one page's script scope is the page plus every file it
 * transitively includes. Two pages that share no includes are entirely separate
 * scopes: a `total` in one has nothing to do with a `total` in the other.
 *
 * So the files that can legally reference a module-level declaration in `seed` are:
 *   • every page whose script scope contains `seed`  — walk the include edges UP,
 *     which is how a Sub declared in a .inc reaches the pages that include it;
 *   • everything those pages include             — walk back DOWN, because a
 *     sibling include of the same page shares the one script scope too
 *     (header.inc declares it, footer.inc uses it, page.asp includes both).
 *
 * Both walks are breadth-first over a visited set, so circular includes terminate.
 *
 * `edges` maps a lower-cased path to the lower-cased paths it directly includes;
 * every known file must be a key, even with no includes. Returns lower-cased paths.
 */
export function includeClosure(edges: Map<string, string[]>, seed: string): Set<string> {
    // Reverse edges: which files include a given file.
    const includedBy = new Map<string, string[]>();
    for (const [file, includes] of edges) {
        for (const inc of includes) {
            const list = includedBy.get(inc);
            if (list) { list.push(file); } else { includedBy.set(inc, [file]); }
        }
    }

    // UP: every page whose script scope contains the seed.
    const pages = new Set<string>([seed]);
    const up = [seed];
    while (up.length > 0) {
        const current = up.pop()!;
        for (const parent of includedBy.get(current) ?? []) {
            if (!pages.has(parent)) { pages.add(parent); up.push(parent); }
        }
    }

    // DOWN from all of them: each page's full script scope, siblings included.
    const closure = new Set<string>(pages);
    const down = [...pages];
    while (down.length > 0) {
        const current = down.pop()!;
        for (const child of edges.get(current) ?? []) {
            if (!closure.has(child)) { closure.add(child); down.push(child); }
        }
    }

    return closure;
}

/**
 * The file paths that DECLARE `nameLower`, out of the merged symbols of a document
 * and its includes. Used to seed includeClosure: the declaration may live in an
 * include, and its scope is that include's, not the current page's.
 *
 * Every declaring file is returned, not just the first. When a page and one of its
 * includes both declare the name they are the same variable at runtime (one script
 * scope), so the rename has to cover the union of their scopes or it leaves stale
 * references behind.
 */
export function declaringFilesFor(sym: FileSymbols, nameLower: string): string[] {
    const paths = new Set<string>();
    const match = (name: string) => name.toLowerCase() === nameLower;

    for (const f  of sym.functions)    { if (match(f.name))  { paths.add(f.filePath); } }
    for (const c  of sym.classes)      { if (match(c.name))  { paths.add(c.filePath); } }
    for (const v  of sym.variables)    { if (match(v.name))  { paths.add(v.filePath); } }
    for (const c  of sym.constants)    { if (match(c.name))  { paths.add(c.filePath); } }
    for (const cv of sym.comVariables) { if (match(cv.name)) { paths.add(cv.filePath); } }

    return [...paths];
}

/**
 * True when `nameLower` is declared inside a Class — a member, reached as
 * `obj.name` from outside. Any other name written after a dot belongs to
 * something else: `total` is not `obj.total`, and a variable `count` is not a
 * Dictionary's `dict.Count`.
 */
export function isClassMember(sym: FileSymbols, nameLower: string): boolean {
    const inClass = (filePath: string, line: number) =>
        sym.classes.some(c => c.filePath === filePath && c.line < line && line <= c.endLine);
    return [...sym.functions, ...sym.variables, ...sym.constants]
        .some(s => s.name.toLowerCase() === nameLower && inClass(s.filePath, s.line));
}

/**
 * A workspace-wide include graph, plus a map back to case-preserved paths.
 *
 * `openPath`/`openText` inject the current (possibly unsaved) buffer so an include
 * the user has just typed is already part of the graph.
 */
interface IncludeGraph {
    edges:    Map<string, string[]>;
    realPath: Map<string, string>;
}

function buildWorkspaceIncludeGraph(openPath: string, openText: string): IncludeGraph {
    const edges    = new Map<string, string[]>();
    const realPath = new Map<string, string>();
    const openKey  = openPath.toLowerCase();

    const add = (fsPath: string, text: string) => {
        const key = fsPath.toLowerCase();
        if (edges.has(key)) { return; }
        realPath.set(key, fsPath);

        const targets = resolveDirectIncludes(text, fsPath);
        for (const target of targets) {
            const targetKey = target.toLowerCase();
            if (!realPath.has(targetKey)) { realPath.set(targetKey, target); }
        }
        edges.set(key, targets.map(p => p.toLowerCase()));
    };

    // The open buffer first, so its edges win over the copy on disk.
    add(openPath, openText);

    // The same list Ctrl+T searches, so a page kept in a .html file through
    // files.associations is part of the graph too.
    for (const fsPath of getWorkspaceAspFiles()) {
        if (fsPath.toLowerCase() === openKey) { continue; }
        add(fsPath, readIncludeText(fsPath) ?? '');
    }

    // An include that resolved outside the workspace folders is still part of the
    // scope; give it a node so the walks can reach it.
    for (const targets of [...edges.values()]) {
        for (const target of targets) {
            if (!edges.has(target)) { edges.set(target, []); }
        }
    }

    return { edges, realPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// AspRenameProvider
//
// Implements F2 rename for VBScript functions, subs, variables, constants, and
// COM object variables — across the current file and all #include'd files.
//
// prepareRename:    validates the word under the cursor is a renameable symbol.
// provideRenameEdits: scans every relevant file and returns a WorkspaceEdit.
// ─────────────────────────────────────────────────────────────────────────────

export class AspRenameProvider implements vscode.RenameProvider {

    // ── prepareRename ─────────────────────────────────────────────────────────
    // Called before the rename input box appears. Return the current word range
    // so VS Code pre-fills it, or throw to show an error and abort.
    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) throw new Error('No symbol found at cursor position.');

        const word = document.getText(wordRange);
        const offset = document.offsetAt(position);
        const fullText = document.getText();

        // Only allow rename inside ASP blocks — renaming HTML tag names or CSS
        // identifiers is not something this provider handles.
        // getZone covers both <% %> blocks and <script language="vbscript"> blocks.
        if (getZone(fullText, offset) !== 'asp') {
            throw new Error('Rename is only supported for VBScript symbols inside ASP blocks.');
        }

        if (VBSCRIPT_KEYWORDS_SET.has(word.toLowerCase())) {
            throw new Error(`"${word}" is a VBScript keyword and cannot be renamed.`);
        }

        // Make sure it actually matches a known user-defined symbol.
        const symbols = collectAllSymbols(document);
        const wordLower = word.toLowerCase();
        const known =
            symbols.functions.some((s) => s.name.toLowerCase() === wordLower) ||
            symbols.variables.some((s) => s.name.toLowerCase() === wordLower) ||
            symbols.constants.some((s) => s.name.toLowerCase() === wordLower) ||
            symbols.comVariables.some(
                (s) => s.name.toLowerCase() === wordLower,
            );

        if (!known) {
            throw new Error(`"${word}" is not a recognised VBScript symbol.`);
        }

        return { range: wordRange, placeholder: word };
    }

    // ── provideRenameEdits ────────────────────────────────────────────────────
    // Called after the user confirms the new name. Returns a WorkspaceEdit
    // that replaces every occurrence of the old name in all relevant files.
    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string
    ): vscode.ProviderResult<vscode.WorkspaceEdit> {

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const oldName = document.getText(wordRange);
        const fullText = document.getText();
        const docPath = document.uri.fsPath;
        const edit = new vscode.WorkspaceEdit();

        // Validate the new name is a legal VBScript identifier.
        if (!/^[a-zA-Z_]\w*$/.test(newName)) {
            vscode.window.showErrorMessage(
                `"${newName}" is not a valid VBScript identifier. ` +
                `Names must start with a letter or underscore and contain only letters, digits, and underscores.`
            );
            return null;
        }

        if (VBSCRIPT_KEYWORDS_SET.has(newName.toLowerCase())) {
            vscode.window.showErrorMessage(`"${newName}" is a VBScript keyword and cannot be used as an identifier.`);
            return null;
        }

        // ── Scope-aware rename ────────────────────────────────────────────────
        // A local variable/parameter must NOT be renamed across other functions
        // or other files. If the caret is inside a Sub/Function/Property body and
        // the symbol is local to it, restrict the edits to that body in THIS file.
        const symbols    = collectAllSymbols(document);
        const members    = isClassMember(symbols, oldName.toLowerCase());
        const localScope = computeLocalRenameScope(
            extractSymbols(fullText, docPath),
            position.line,
            oldName.toLowerCase(),
        );
        if (localScope) {
            for (const { line, character } of findAllOccurrences(fullText, oldName, { members })) {
                if (line < localScope.line || line > localScope.endLine) { continue; }
                edit.replace(
                    document.uri,
                    new vscode.Range(
                        new vscode.Position(line, character),
                        new vscode.Position(line, character + oldName.length),
                    ),
                    newName,
                );
            }
            return edit;
        }

        // ── Script-scope-aware file set ───────────────────────────────────────
        // Only the files that share a script scope with the DECLARATION may be
        // rewritten. See includeClosure for why that is the include closure and
        // not the workspace.
        //
        // This used to search the current document, its includes, AND every other
        // .asp / .inc file found by walking the workspace folders. F2 on a common
        // name — total, i, id, sql, conn, rs — silently rewrote that word in every
        // unrelated page on the site, in one undo step the user could easily miss.
        const declaringPaths = declaringFilesFor(symbols, oldName.toLowerCase());
        const seeds = declaringPaths.length > 0 ? declaringPaths : [docPath];

        const { edges, realPath } = buildWorkspaceIncludeGraph(docPath, fullText);

        const scope = new Set<string>();
        for (const seed of seeds) {
            for (const key of includeClosure(edges, seed.toLowerCase())) { scope.add(key); }
        }

        const docKey = docPath.toLowerCase();
        scope.add(docKey); // the caret's own file, even for an untracked path

        for (const key of scope) {
            const fsPath = realPath.get(key) ?? key;
            // Prefer the open buffer (unsaved edits) over disk so edit positions
            // line up with what the user actually sees.
            const text = key === docKey ? fullText : (readIncludeText(fsPath) ?? '');
            if (!text) { continue; }

            // The page's own uri, not one rebuilt from its path: an unsaved
            // Untitled-1 has no file, and an edit aimed at file:///Untitled-1
            // is refused, so nothing was renamed at all.
            const fileUri = key === docKey ? document.uri : vscode.Uri.file(fsPath);

            // A procedure that declares its own `oldName` — as a parameter or an
            // explicit Dim/Const — holds a DIFFERENT variable, so its body must be
            // left alone when renaming the module-level one.
            const skip = shadowingBodies(extractSymbols(text, fsPath), oldName.toLowerCase());
            const isShadowed = (line: number) =>
                skip.some(body => body.line <= line && line <= body.endLine);

            for (const { line, character } of findAllOccurrences(text, oldName, { members })) {
                if (isShadowed(line)) { continue; }
                edit.replace(
                    fileUri,
                    new vscode.Range(
                        new vscode.Position(line, character),
                        new vscode.Position(line, character + oldName.length),
                    ),
                    newName,
                );
            }
        }

        reportCrossFileRename(edit, oldName);

        return edit;
    }
}

/**
 * Tells the user when a rename reached beyond the current file.
 *
 * VS Code applies a rename's WorkspaceEdit in one shot with no confirmation, and
 * nothing in the UI advertises the built-in preview (Ctrl+Shift+Enter instead of
 * Enter in the rename box). Editing several files with no feedback at all is easy
 * to miss until it turns up in a diff, so say what was touched. It is one undo
 * step, which is worth saying too.
 */
function reportCrossFileRename(edit: vscode.WorkspaceEdit, oldName: string): void {
    const entries = edit.entries();
    if (entries.length <= 1) { return; }

    const occurrences = entries.reduce((total, [, edits]) => total + edits.length, 0);
    vscode.window.showInformationMessage(
        `Renamed ${occurrences} occurrence${occurrences === 1 ? '' : 's'} of ` +
        `"${oldName}" across ${entries.length} files. Ctrl+Z undoes all of them.`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// findAllOccurrences
//
// Scans `text` for every occurrence of `name` that:
//   - is a whole word (word-boundary match)
//   - sits inside an ASP block (<% ... %>)
//   - is not inside a string literal ("...")
//   - is not part of a VBScript comment (' ...)
//   - is not a member written after a dot (`obj.total`), unless `members`
//
// VBScript is case-insensitive, so matching is case-insensitive.
// Returns line + character positions (0-based) of every match start.
//
// Exported for unit testing.
// ─────────────────────────────────────────────────────────────────────────────

export function findAllOccurrences(
    text: string,
    name: string,
    { members = false }: { members?: boolean } = {},
): { line: number; character: number }[] {

    const results: { line: number; character: number }[] = [];
    // \b word boundary + case-insensitive flag so "myFunc" matches "MyFunc"
    const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');

    // Build a per-character map of which offsets hold VBScript. We replicate the
    // lightweight bitmap approach from aspSemanticProvider rather than calling
    // isInsideAspBlock() in a loop (which would be O(n²)).
    const vbsMap = buildVbScriptMap(text);

    // Matches arrive in document order, so the line number is carried forward
    // rather than recounted from the top of the file for every one of them.
    let lineNumber = 0;
    let countedTo  = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const offset = match.index;

        // Must be VBScript — a <% %> block or a VBScript <script> body
        if (!vbsMap[offset]) continue;

        // `obj.total` is a member of obj, and `.total` inside a With block
        // one of the With object — neither is the variable `total`.
        if (!members && text[offset - 1] === '.') continue;

        // Must not be inside a string literal or comment on the same line.
        // The check runs over the WHOLE physical line via isInsideVbStringOrComment,
        // which starts scanning at the line's VBScript rather than at column 0. A
        // single line often mixes HTML and script — `<td>it's here</td><% total = 1 %>`
        // — and reading from column 0 made the apostrophe in ordinary HTML text look
        // like the start of a VBScript comment, so every occurrence after it on that
        // line was silently skipped and the rename came out half-applied.
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1; // 0 when on line 0
        const colInLine = offset - lineStart;
        const lineEnd   = text.indexOf('\n', offset);
        const lineText  = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);

        if (isInsideVbStringOrComment(lineText, colInLine)) continue;

        lineNumber += countNewlines(text, countedTo, offset);
        countedTo   = offset;
        results.push({ line: lineNumber, character: colInLine });
    }

    return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Escapes special regex characters in a literal string. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a Uint8Array where the map[i] === 1 means offset i holds VBScript.
 *
 * Two kinds of region qualify, matching what getZone calls the `asp` zone:
 *
 *   • `<% … %>` blocks. The scan is purely lexical: the first `%>` closes a
 *     block, even one that sits inside a VBScript string or comment. This matches
 *     the ASP engine, so rename never rewrites text the engine would treat as
 *     HTML output rather than script.
 *   • `<script language="vbscript">` bodies, client-side or `runat="server"`.
 *     Mapping only `<% %>` meant prepareRename offered a rename inside these (the
 *     zone resolver correctly calls them VBScript) but the scanner then found no
 *     occurrences, so F2 silently did nothing at all.
 *
 * String/comment exclusion for the identifier itself is handled separately by
 * isInsideVbStringOrComment().
 */
function buildVbScriptMap(text: string): Uint8Array {
    const map = new Uint8Array(text.length);
    let i = 0;

    while (i < text.length) {
        const openIdx = text.indexOf('<%', i);
        if (openIdx === -1) break;

        const closeIdx = text.indexOf('%>', openIdx + 2);
        const end = closeIdx === -1 ? text.length : closeIdx + 2;

        for (let j = openIdx; j < end; j++) {
            map[j] = 1;
        }

        i = closeIdx === -1 ? text.length : closeIdx + 2;
    }

    for (const { start, end } of getVbScriptBlockRanges(text)) {
        for (let j = start; j < end; j++) {
            map[j] = 1;
        }
    }

    return map;
}

/**
 * Counts the newline characters in `text` from `from` up to (not including)
 * `to`. Working on the raw string rather than document.positionAt() is what
 * lets this run over files read straight from disk.
 */
function countNewlines(text: string, from: number, to: number): number {
    let count = 0;
    for (let i = from; i < to; i++) {
        if (text[i] === '\n') count++;
    }
    return count;
}