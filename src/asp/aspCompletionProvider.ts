import * as vscode from 'vscode';
import {
    ASP_OBJECTS, ASP_OBJECT_NAMES, VBSCRIPT_KEYWORDS, VBSCRIPT_FUNCTIONS, VBSCRIPT_CONSTANTS,
    BUILTIN_FUNCTION_DOCS, builtinSignature,
} from '../constants/aspKeywords';
import { getTextBeforeCursor } from '../platform/documentHelper';
import { contextAt } from '../platform/documentState';
import { areIncludeSymbolsReady, preloadIncludeSymbols, withIncludeSymbols } from './includeProvider';
import { analysedPage } from './vbscriptWorkspace';
import { COM_TYPE_MAP } from '../constants/comObjects';
import { withObjectAt, withObjectType, type WithObject } from '../vbscript/pageAnalysis';
import * as path from 'path';
import { applyKeywordCase } from '../formatter/aspFormatter';
import { formatterSettings } from '../platform/settings';


// Builds a variable → progId map from the page's and its includes' COM variables
// (chained COM inference included). No need to re-scan the document text here.
function buildComVarMap(includeComVars: { name: string; progId: string }[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const cv of includeComVars) {
        if (!map.has(cv.name.toLowerCase())) {
            map.set(cv.name.toLowerCase(), cv.progId);
        }
    }
    return map;
}

export class AspCompletionProvider implements vscode.CompletionItemProvider {

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {

        const version  = document.version;

        // Only inside VBScript, and not in a VBScript string literal or a comment
        // (e.g. `x = "rs."` or after a `'`), where the token is data, not code.
        const caret = contextAt(document, position);
        if (caret.zone !== 'asp' || caret.inVbStringOrComment) return [];
        const offset = caret.offset;

        const textBefore   = getTextBeforeCursor(document, position);
        const lineText     = document.lineAt(position.line).text.substring(0, position.character);
        const completions: vscode.CompletionItem[] = [];

        // If triggered by a space, only continue if we're in a "Call " context.
        // This prevents the suggestion list popping up on every single space the user types.
        if (context.triggerCharacter === ' ' && !/\bCall\s+$/i.test(lineText)) {
            return [];
        }

        // ── Standalone underscore guard ───────────────────────────────────────
        // Suppress completions when the current word being typed is exactly `_`
        // and nothing else — this is the VBScript line continuation symbol.
        //
        // We get the word immediately before the cursor using VS Code's word range.
        // If it is a single `_` character, return nothing.
        //
        // Typing `row_` → word is `row_`  → NOT suppressed (more than just `_`)
        // Typing `_v`   → word is `_v`    → NOT suppressed
        // Typing `_`    → word is `_`     → SUPPRESSED
        //
        // This is the most reliable approach because it works regardless of what
        // comes before the underscore on the line.
        const wordRange = document.getWordRangeAtPosition(position, /[\w]+/);
        const currentWord = wordRange ? document.getText(wordRange) : '';
        if (currentWord === '_') {
            return [];
        }

        // Include files are loaded off the extension-host thread. Do not await the
        // worker here: return current-document + already-cached symbols immediately,
        // then refresh suggestions once the background include load completes.
        const refreshSuggestions = !areIncludeSymbolsReady(document);
        if (refreshSuggestions) {
            void preloadIncludeSymbols(document).then(() => {
                const editor = vscode.window.activeTextEditor;
                if (editor?.document === document && areIncludeSymbolsReady(document)) {
                    void vscode.commands.executeCommand('editor.action.triggerSuggest');
                }
            });
        }

        // The page's own symbols come from the VBScript worker, so a large page
        // is not parsed on this thread on every keystroke. Typing on while it
        // reads gives the symbols of the newer text, which are as good. Then
        // whatever include symbols are cached.
        const page = await analysedPage(document, token);
        if (!page || token.isCancellationRequested) { return undefined; }
        const allSymbols = withIncludeSymbols(document, page.symbols);
        const comVarMap  = buildComVarMap(allSymbols.comVariables);

        // ── 1. A member of the With object  e.g. "  .EO" inside With rs ───────
        // A dot with no name before it. Only a member can follow it, so outside
        // a With block — or in one whose object is unknown — there is nothing to
        // offer; the keyword and function list is never right here.
        const withDot = /(?:^|[^\w)\].])\.(\w*)$/.exec(lineText);
        if (withDot && !/^\d/.test(withDot[1])) {
            // Typed on while the worker read the page: its offsets are not this text's.
            if (page.version !== version) { return undefined; }
            return this.provideWithMembers(withObjectAt(page.blocks.withBlocks, offset), comVarMap);
        }

        // ── 2. Object member access  e.g. "rs."  or "rs.EO" ─────────────────
        // Matches:  word.  OR  word.partialword  (both need member completions)
        const dotAccessMatch = lineText.match(/\b(\w+)\.(\w*)$/);
        if (dotAccessMatch) {
            const varName    = dotAccessMatch[1];

            // 2a. Built-in ASP objects (Response, Request, etc.). Driven by the
            // object list rather than a literal, so adding one there is enough.
            if (ASP_OBJECT_NAMES.has(varName.toLowerCase())) {
                return this.provideMethodCompletions(varName);
            }

            // 2b. User variable with a known COM type (rs., conn., dict., etc.)
            const progId = comVarMap.get(varName.toLowerCase());
            if (progId && COM_TYPE_MAP[progId]) {
                return this.provideComObjectMembers(varName, progId);
            }

            // 2c. Unknown object — return empty so keywords don't pollute
            return [];
        }

        // ── 3. Normal ASP context completions ────────────────────────────────

        // Don't expand "If/Sub/Function" snippets when the user typed "End ..."
        // Detect 'End <keyword>' so we don't re-expand block snippets after End
        const isAfterEnd = /\bend\s*(if|sub|function|with|select|class|property)?\s*$/i.test(textBefore.trim());

        completions.push(...this.provideAspObjectCompletions());
        completions.push(...this.provideKeywordCompletions(isAfterEnd));
        completions.push(...this.provideFunctionCompletions());
        completions.push(...this.provideConstantCompletions());

        // ── 4. User-defined symbols (current doc + include files) ─────────────

        // Variables (Dim)
        // Skip any Dim'd variable that also has a Set CreateObject entry —
        // the COM variable entry below already represents it with richer type info.
        const seenVars = new Set<string>();
        for (const v of allSymbols.variables) {
            if (seenVars.has(v.name.toLowerCase())) continue;
            seenVars.add(v.name.toLowerCase());

            // If this variable is also a COM object (Set x = CreateObject(...)),
            // skip it here — the COM variables section will show it with type info.
            if (comVarMap.has(v.name.toLowerCase())) continue;

            const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Variable);
            const fromInclude = v.filePath !== document.uri.fsPath;
            item.detail       = fromInclude ? `Variable (from ${path.basename(v.filePath)})` : 'Variable (Dim)';
            item.documentation = new vscode.MarkdownString(`**${v.name}** — ${fromInclude ? 'included variable' : 'declared in this file'}`);
            item.sortText     = '2_' + v.name;
            item.preselect    = false;
            completions.push(item);
        }

        // Constants (Const)
        const seenConsts = new Set<string>();
        for (const c of allSymbols.constants) {
            if (seenConsts.has(c.name.toLowerCase())) continue;
            seenConsts.add(c.name.toLowerCase());

            const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Constant);
            const fromInclude = c.filePath !== document.uri.fsPath;
            item.detail       = `Const = ${c.value}${fromInclude ? ` (from ${path.basename(c.filePath)})` : ''}`;
            item.documentation = new vscode.MarkdownString(`**${c.name}** = \`${c.value}\``);
            item.sortText     = '2_' + c.name;
            item.preselect    = false;
            completions.push(item);
        }

        // Functions and Subs
        // VBScript calling convention rules:
        //
        //   Without Call keyword:
        //     Sub, no params   -> ConnectDb                  (no parens)
        //     Sub, with params -> ConnectDb arg1, arg2       (space-separated, NO parens)
        //     Function         -> result = MyFunc(arg)       (parens, return value assigned)
        //
        //   With Call keyword (user already typed "Call "):
        //     Sub, no params   -> Call ConnectDb             (no parens)
        //     Sub, with params -> Call MySub(arg1, arg2)     (parens required by VBScript)
        //     Function         -> Call MyFunc(arg)           (parens required)
        //
        //   Special edge case: Sub with exactly ONE param without Call ->
        //     MySub(arg) technically works but passes arg ByVal, not ByRef.
        //     We still insert without parens to be safe and consistent.
        //
        // Detect if the user is in a "Call ..." context on this line.
        // We check the current line text (not textBefore which may be multiline)
        // and match either:
        //   "Call "           (just typed Call and a space)
        //   "Call SomeName"   (typing the sub name after Call)
        const isAfterCall = /\bCall\s+\w*$/i.test(lineText);

        const seenFuncs = new Set<string>();
        for (const fn of allSymbols.functions) {
            if (seenFuncs.has(fn.name.toLowerCase())) continue;
            seenFuncs.add(fn.name.toLowerCase());

            const isSub       = fn.kind === 'Sub';
            const hasParams   = fn.params.trim().length > 0;
            const fromInclude = fn.filePath !== document.uri.fsPath;

            // Build param snippet list e.g.  ${1:name}, ${2:value}
            const paramSnippet = fn.params.split(',').map((p, i) =>
                `\${${i + 1}:${p.trim()}}`
            ).join(', ');

            const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
            item.detail = `${fn.kind} ${fn.name}${hasParams ? `(${fn.params})` : ''}${fromInclude ? ` — from ${path.basename(fn.filePath)}` : ''}`;
            item.documentation = new vscode.MarkdownString(
                `**${fn.name}** — ${fromInclude ? 'included' : 'defined in this file'}\n\n` +
                `\`${fn.kind} ${fn.name}${hasParams ? `(${fn.params})` : ''}\``
            );

            if (isAfterCall) {
                // User typed "Call " — parens required for any params
                if (!hasParams) {
                    // Call ConnectDb  (no parens when no args)
                    item.insertText = fn.name;
                } else {
                    // Call MySub(arg1, arg2)
                    item.insertText = new vscode.SnippetString(`${fn.name}(${paramSnippet})`);
                }
            } else if (isSub) {
                // No Call, Sub — never use parens around the argument list
                if (!hasParams) {
                    item.insertText = fn.name;
                } else {
                    // ConnectDb arg1, arg2
                    item.insertText = new vscode.SnippetString(`${fn.name} ${paramSnippet}`);
                }
            } else {
                // No Call, Function — always parens (return value expected)
                if (!hasParams) {
                    item.insertText = new vscode.SnippetString(`${fn.name}()`);
                } else {
                    item.insertText = new vscode.SnippetString(`${fn.name}(${paramSnippet})`);
                }
            }

            item.sortText  = '2_' + fn.name;
            item.preselect = false;
            completions.push(item);
        }

        // COM object variable names (Set rs = ...) — suggest the variable name itself
        const seenCom = new Set<string>();
        for (const cv of allSymbols.comVariables) {
            if (seenCom.has(cv.name.toLowerCase())) continue;
            seenCom.add(cv.name.toLowerCase());

            const typeDef     = COM_TYPE_MAP[cv.progId];
            const fromInclude = cv.filePath !== document.uri.fsPath;
            const item = new vscode.CompletionItem(cv.name, vscode.CompletionItemKind.Variable);
            item.detail       = typeDef
                ? `${typeDef.label}${fromInclude ? ` (from ${path.basename(cv.filePath)})` : ''}`
                : `Object${fromInclude ? ` (from ${path.basename(cv.filePath)})` : ''}`;
            item.documentation = typeDef
                ? new vscode.MarkdownString(`**${cv.name}** — \`${typeDef.label}\`\n\nType \`${cv.name}.\` to see members.`)
                : new vscode.MarkdownString(`**${cv.name}** — COM object variable`);
            item.sortText     = '2_' + cv.name;
            item.preselect    = false;
            completions.push(item);
        }

        return completions;
    }

    // ── Provide ASP built-in object completions (Response, Request, etc.) ────
    private provideAspObjectCompletions(): vscode.CompletionItem[] {
        return ASP_OBJECTS.map(obj => {
            const item = new vscode.CompletionItem(obj.name, vscode.CompletionItemKind.Class);
            item.detail = obj.description;
            item.documentation = new vscode.MarkdownString(
                `**${obj.name}** Object\n\n${obj.description}\n\n` +
                `**Methods/Properties:** ${obj.members.map(m => m.name).join(', ')}`
            );
            item.preselect = false;
            item.sortText  = '1_' + obj.name;
            return item;
        });
    }

    // ── Members of a known COM object variable (rs., conn., dict., etc.) ─────
    /** The members of a With block's object, found the way hover finds them (withObjectType). */
    private provideWithMembers(object: WithObject | null | undefined, comVarMap: Map<string, string>): vscode.CompletionItem[] {
        const type = withObjectType(object, comVarMap);
        if (!type) { return []; }
        if (ASP_OBJECT_NAMES.has(type)) { return this.provideMethodCompletions(type); }
        const label = object && 'name' in object && !object.method ? object.name : COM_TYPE_MAP[type]?.label;
        return label ? this.provideComObjectMembers(label, type) : [];
    }

    private provideComObjectMembers(varName: string, progId: string): vscode.CompletionItem[] {
        const typeDef = COM_TYPE_MAP[progId];
        if (!typeDef) return [];

        return typeDef.members.map(member => {
            const item = new vscode.CompletionItem(member.name, vscode.CompletionItemKind.Property);
            item.detail       = `${varName}.${member.name}  [${typeDef.label}]`;
            item.documentation = new vscode.MarkdownString(`**${typeDef.label}.${member.name}**\n\n${member.doc}`);
            item.insertText   = member.snippet
                ? new vscode.SnippetString(member.snippet)
                : member.name;
            item.preselect    = false;
            item.sortText     = '0_' + member.name;
            return item;
        });
    }

    // ── Members of built-in ASP objects (Response.Write, etc.) ───────────────
    private provideMethodCompletions(objectName: string): vscode.CompletionItem[] {
        const aspObject = ASP_OBJECTS.find(obj =>
            obj.name.toLowerCase() === objectName.toLowerCase()
        );
        if (!aspObject) return [];

        return aspObject.members.map(member => {
            const kind = member.kind === 'method'
                ? vscode.CompletionItemKind.Method
                : member.kind === 'collection'
                    ? vscode.CompletionItemKind.Field
                    : vscode.CompletionItemKind.Property;

            const item = new vscode.CompletionItem(member.name, kind);
            item.detail = `${aspObject.name}.${member.name}  [${member.kind}]`;
            item.documentation = new vscode.MarkdownString(
                `**${aspObject.name}.${member.name}**\n\n${member.doc}`,
            );
            item.insertText = member.snippet
                ? new vscode.SnippetString(member.snippet)
                : member.name;
            item.preselect = false;
            item.sortText  = '0_' + member.name;
            return item;
        });
    }

    // ── VBScript keyword completions ──────────────────────────────────────────
    private provideKeywordCompletions(isAfterEnd: boolean = false): vscode.CompletionItem[] {
        return VBSCRIPT_KEYWORDS.map(kw => {
            const item = new vscode.CompletionItem(kw.keyword, vscode.CompletionItemKind.Keyword);
            item.detail       = kw.description;
            item.documentation = new vscode.MarkdownString(`**${kw.keyword}**\n\n${kw.description}`);

            if (isAfterEnd && ['If', 'Sub', 'Function', 'Select Case', 'While', 'Do', 'For', 'For Each', 'With', 'Class', 'Property'].includes(kw.keyword)) {
                item.preselect = false;
                item.sortText  = '1_' + kw.keyword;
                return item;
            }

            if (kw.keyword === 'If') {
                item.insertText = new vscode.SnippetString('If ${1:condition} Then\n\t$0\nEnd If');
                item.kind       = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'For') {
                item.insertText = new vscode.SnippetString('For ${1:i} = ${2:0} To ${3:10}\n\t$0\nNext');
                item.kind       = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'For Each') {
                item.insertText = new vscode.SnippetString('For Each ${1:item} In ${2:collection}\n\t$0\nNext');
                item.kind       = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'While') {
                item.insertText = new vscode.SnippetString('While ${1:condition}\n\t$0\nWend');
                item.kind       = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'Do') {
                item.insertText = new vscode.SnippetString('Do\n\t$0\nLoop');
                item.kind       = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'Select Case') {
                item.insertText = new vscode.SnippetString('Select Case ${1:expression}\n\tCase ${2:value}\n\t\t$0\nEnd Select');
                item.kind       = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'Sub') {
                item.insertText = new vscode.SnippetString('Sub ${1:SubName}(${2:parameters})\n\t$0\nEnd Sub');
                item.kind       = vscode.CompletionItemKind.Snippet;
            } else if (kw.keyword === 'Function') {
                item.insertText = new vscode.SnippetString('Function ${1:FunctionName}(${2:parameters})\n\t$0\nEnd Function');
                item.kind       = vscode.CompletionItemKind.Snippet;
            }

            // In the casing Format Document would give it, so a block is not
            // half lowercase until the page is next formatted.
            if (item.insertText instanceof vscode.SnippetString) {
                item.insertText = new vscode.SnippetString(applyKeywordCase(item.insertText.value, formatterSettings().keywordCase));
            }
            item.preselect = false;
            item.sortText  = (item.insertText ? '0_' : '1_') + kw.keyword;
            return item;
        });
    }

    // ── VBScript built-in function completions ────────────────────────────────
    // The signature and doc are the ones hover and parameter hints show.
    private provideFunctionCompletions(): vscode.CompletionItem[] {
        return VBSCRIPT_FUNCTIONS.map(func => {
            const doc  = BUILTIN_FUNCTION_DOCS[func.toLowerCase()];
            const item = new vscode.CompletionItem(func, vscode.CompletionItemKind.Function);
            item.detail       = (doc && builtinSignature(doc)?.label) || 'VBScript function';
            item.documentation = new vscode.MarkdownString(doc ?? `**${func}()** - VBScript built-in function`);
            item.insertText   = new vscode.SnippetString(`${func}($0)`);
            item.preselect    = false;
            item.sortText     = '0_' + func;
            return item;
        });
    }

    // ── VBScript's built-in constants (vbCrLf, vbTextCompare, ...) ──────────
    // They are not functions, so they take no call parentheses, and they are
    // not keywords either — a page writes `s & vbCrLf` as an ordinary value.
    private provideConstantCompletions(): vscode.CompletionItem[] {
        return VBSCRIPT_CONSTANTS.map(constant => {
            const item = new vscode.CompletionItem(constant.name, vscode.CompletionItemKind.Constant);
            item.detail        = 'VBScript constant';
            item.documentation = new vscode.MarkdownString(`**${constant.name}**\n\n${constant.doc}`);
            item.preselect     = false;
            item.sortText      = '0_' + constant.name;
            return item;
        });
    }
}