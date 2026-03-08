import * as vscode from 'vscode';
import { ASP_OBJECTS, VBSCRIPT_KEYWORDS, VBSCRIPT_FUNCTIONS } from '../constants/aspKeywords';
import { getContext, ContextType, getTextBeforeCursor } from '../utils/documentHelper';
import { collectAllSymbols } from './includeProvider';
import { COM_TYPE_MAP } from '../constants/comObjects';


// ─────────────────────────────────────────────────────────────────────────────
// Builds a variable → progId map from the combined symbols
// (current doc + all include files), used for dot-access member completions.
// ─────────────────────────────────────────────────────────────────────────────
function buildComVarMap(documentText: string, includeComVars: { name: string; progId: string }[]): Map<string, string> {
    const map = new Map<string, string>();

    // From the current document text directly
    const pattern = /\bSet\s+(\w+)\s*=\s*(?:Server\.)?CreateObject\s*\(\s*["']([^"']+)["']\s*\)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(documentText)) !== null) {
        map.set(match[1].toLowerCase(), match[2].toLowerCase());
    }

    // From include files (already parsed by collectAllSymbols)
    for (const cv of includeComVars) {
        if (!map.has(cv.name.toLowerCase())) {
            map.set(cv.name.toLowerCase(), cv.progId);
        }
    }

    return map;
}

export class AspCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const docContext = getContext(document, position);

        // Only provide ASP completions inside ASP blocks
        if (docContext !== ContextType.ASP) {
            return [];
        }

        const textBefore   = getTextBeforeCursor(document, position);
        const documentText = document.getText();
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

        // Collect all symbols from this document + any included files
        const allSymbols = collectAllSymbols(document);
        const comVarMap  = buildComVarMap(documentText, allSymbols.comVariables);

        // ── 1. Object member access  e.g. "rs."  or "rs.EO" ─────────────────
        // Matches:  word.  OR  word.partialword  (both need member completions)
        const dotAccessMatch = lineText.match(/\b(\w+)\.(\w*)$/);
        if (dotAccessMatch) {
            const varName    = dotAccessMatch[1];

            // 1a. Built-in ASP objects (Response, Request, etc.)
            if (/^(Response|Request|Server|Session|Application)$/i.test(varName)) {
                return this.provideMethodCompletions(varName);
            }

            // 1b. User variable with a known COM type (rs., conn., dict., etc.)
            const progId = comVarMap.get(varName.toLowerCase());
            if (progId && COM_TYPE_MAP[progId]) {
                return this.provideComObjectMembers(varName, progId);
            }

            // 1c. Unknown object — return empty so keywords don't pollute
            return [];
        }

        // ── 2. Normal ASP context completions ────────────────────────────────

        // Don't expand "If/Sub/Function" snippets when the user typed "End ..."
        const isAfterEnd = /\bend\s+i?f?$/i.test(textBefore.trim());

        completions.push(...this.provideAspObjectCompletions());
        completions.push(...this.provideKeywordCompletions(isAfterEnd));
        completions.push(...this.provideFunctionCompletions());

        // ── 3. User-defined symbols (current doc + include files) ─────────────

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
            item.detail       = fromInclude ? `Variable (from ${require('path').basename(v.filePath)})` : 'Variable (Dim)';
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
            item.detail       = `Const = ${c.value}${fromInclude ? ` (from ${require('path').basename(c.filePath)})` : ''}`;
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
            item.detail = `${fn.kind} ${fn.name}${hasParams ? `(${fn.params})` : ''}${fromInclude ? ` — from ${require('path').basename(fn.filePath)}` : ''}`;
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
                ? `${typeDef.label}${fromInclude ? ` (from ${require('path').basename(cv.filePath)})` : ''}`
                : `Object${fromInclude ? ` (from ${require('path').basename(cv.filePath)})` : ''}`;
            item.documentation = typeDef
                ? new vscode.MarkdownString(`**${cv.name}** — \`${typeDef.label}\`\n\nType \`${cv.name}.\` to see members.`)
                : new vscode.MarkdownString(`**${cv.name}** — COM object variable`);
            item.sortText     = '2_' + cv.name;
            item.preselect    = false;

            // Trigger member suggestions after accepting this variable
            item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest members' };
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
                `**Methods/Properties:** ${obj.methods.join(', ')}`
            );
            item.preselect = false;
            item.sortText  = '1_' + obj.name;
            item.command   = { command: 'editor.action.triggerSuggest', title: 'Trigger Method Suggestions' };
            return item;
        });
    }

    // ── Members of a known COM object variable (rs., conn., dict., etc.) ─────
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

        return aspObject.methods.map(method => {
            const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Method);
            item.detail = `${objectName}.${method}`;

            switch (method) {
                case 'Write':
                    item.documentation = 'Write output to the client';
                    item.insertText    = new vscode.SnippetString('Write($0)');
                    break;
                case 'Redirect':
                    item.documentation = 'Redirect to another URL';
                    item.insertText    = new vscode.SnippetString('Redirect("$0")');
                    break;
                case 'Form':
                    item.documentation = 'Get form data';
                    item.insertText    = new vscode.SnippetString('Form("$0")');
                    break;
                case 'QueryString':
                    item.documentation = 'Get query string parameter';
                    item.insertText    = new vscode.SnippetString('QueryString("$0")');
                    break;
                case 'CreateObject':
                    item.documentation = 'Create a COM object';
                    item.insertText    = new vscode.SnippetString('CreateObject("$0")');
                    break;
                case 'MapPath':
                    item.documentation = 'Map virtual path to physical path';
                    item.insertText    = new vscode.SnippetString('MapPath("$0")');
                    break;
                case 'HTMLEncode':
                    item.documentation = 'Encode HTML special characters';
                    item.insertText    = new vscode.SnippetString('HTMLEncode($0)');
                    break;
                case 'URLEncode':
                    item.documentation = 'Encode URL special characters';
                    item.insertText    = new vscode.SnippetString('URLEncode($0)');
                    break;
                default:
                    item.documentation = `${objectName}.${method} method`;
                    item.insertText    = method;
            }

            item.preselect = false;
            item.sortText  = '0_' + method;
            return item;
        });
    }

    // ── VBScript keyword completions ──────────────────────────────────────────
    private provideKeywordCompletions(isAfterEnd: boolean = false): vscode.CompletionItem[] {
        return VBSCRIPT_KEYWORDS.map(kw => {
            const item = new vscode.CompletionItem(kw.keyword, vscode.CompletionItemKind.Keyword);
            item.detail       = kw.description;
            item.documentation = new vscode.MarkdownString(`**${kw.keyword}**\n\n${kw.description}`);

            if (isAfterEnd && (kw.keyword === 'If' || kw.keyword === 'Sub' || kw.keyword === 'Function' || kw.keyword === 'Select Case')) {
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

            item.preselect = false;
            item.sortText  = (item.insertText ? '0_' : '1_') + kw.keyword;
            return item;
        });
    }

    // ── VBScript built-in function completions ────────────────────────────────
    private provideFunctionCompletions(): vscode.CompletionItem[] {
        return VBSCRIPT_FUNCTIONS.map(func => {
            const item = new vscode.CompletionItem(func, vscode.CompletionItemKind.Function);
            item.detail       = `VBScript function`;
            item.documentation = new vscode.MarkdownString(`**${func}()** - VBScript built-in function`);
            item.insertText   = new vscode.SnippetString(`${func}($0)`);
            item.preselect    = false;
            item.sortText     = '0_' + func;
            return item;
        });
    }
}