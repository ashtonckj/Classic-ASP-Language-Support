import * as vscode from 'vscode';
import { ASP_OBJECTS, VBSCRIPT_KEYWORDS, VBSCRIPT_FUNCTIONS } from '../constants/aspKeywords';
import { getContext, ContextType, getTextBeforeCursor } from '../utils/documentHelper';
import { collectAllSymbols } from './includeProvider';

// ─────────────────────────────────────────────────────────────────────────────
// Known COM object type definitions
// When the user writes:  Set rs = Server.CreateObject("ADODB.Recordset")
// we detect the ProgID string and map the variable name → one of these types.
// ─────────────────────────────────────────────────────────────────────────────
const COM_TYPE_MAP: Record<string, { label: string; members: { name: string; doc: string; snippet?: string }[] }> = {
    'adodb.recordset': {
        label: 'ADODB.Recordset',
        members: [
            { name: 'EOF',       doc: '`True` when the cursor is past the last record.' },
            { name: 'BOF',       doc: '`True` when the cursor is before the first record.' },
            { name: 'Open',      doc: 'Opens a recordset.',            snippet: 'Open($0)' },
            { name: 'Close',     doc: 'Closes the recordset.',         snippet: 'Close()' },
            { name: 'MoveNext',  doc: 'Moves to the next record.',     snippet: 'MoveNext()' },
            { name: 'MovePrev',  doc: 'Moves to the previous record.', snippet: 'MovePrev()' },
            { name: 'MoveFirst', doc: 'Moves to the first record.',    snippet: 'MoveFirst()' },
            { name: 'MoveLast',  doc: 'Moves to the last record.',     snippet: 'MoveLast()' },
            { name: 'AddNew',    doc: 'Adds a new record.',            snippet: 'AddNew()' },
            { name: 'Update',    doc: 'Saves changes to the current record.', snippet: 'Update()' },
            { name: 'Delete',    doc: 'Deletes the current record.',   snippet: 'Delete()' },
            { name: 'Fields',    doc: 'Collection of field objects.',  snippet: 'Fields("$0")' },
            { name: 'RecordCount', doc: 'Total number of records in the recordset.' },
            { name: 'PageSize',  doc: 'Number of records per page.' },
            { name: 'PageCount', doc: 'Total number of pages.' },
            { name: 'AbsolutePage', doc: 'Current page number.' },
            { name: 'AbsolutePosition', doc: 'Current record position.' },
            { name: 'CursorType',   doc: 'Type of cursor used.' },
            { name: 'LockType',     doc: 'Type of lock used.' },
            { name: 'ActiveConnection', doc: 'The active database connection.' },
            { name: 'Source',       doc: 'The source SQL query or table name.' },
        ]
    },
    'adodb.connection': {
        label: 'ADODB.Connection',
        members: [
            { name: 'Open',            doc: 'Opens a database connection.',      snippet: 'Open("$0")' },
            { name: 'Close',           doc: 'Closes the connection.',            snippet: 'Close()' },
            { name: 'Execute',         doc: 'Executes a SQL command.',           snippet: 'Execute("$0")' },
            { name: 'BeginTrans',      doc: 'Begins a transaction.',             snippet: 'BeginTrans()' },
            { name: 'CommitTrans',     doc: 'Commits the current transaction.',  snippet: 'CommitTrans()' },
            { name: 'RollbackTrans',   doc: 'Rolls back the current transaction.', snippet: 'RollbackTrans()' },
            { name: 'ConnectionString', doc: 'The connection string property.' },
            { name: 'CommandTimeout',  doc: 'Timeout for commands in seconds.' },
            { name: 'ConnectionTimeout', doc: 'Timeout for opening a connection.' },
            { name: 'Errors',          doc: 'Collection of error objects.' },
            { name: 'State',           doc: 'Current state of the connection (open/closed).' },
            { name: 'CursorLocation',  doc: 'Location of the cursor (client/server).' },
        ]
    },
    'adodb.command': {
        label: 'ADODB.Command',
        members: [
            { name: 'Execute',         doc: 'Executes the command.',            snippet: 'Execute()' },
            { name: 'ActiveConnection', doc: 'The active database connection.' },
            { name: 'CommandText',     doc: 'The SQL text or stored procedure name.' },
            { name: 'CommandType',     doc: 'The type of the command (text, stored proc, etc.).' },
            { name: 'CommandTimeout',  doc: 'Timeout in seconds.' },
            { name: 'Parameters',      doc: 'Collection of parameter objects.',  snippet: 'Parameters.Append $0' },
            { name: 'CreateParameter', doc: 'Creates a new parameter object.',  snippet: 'CreateParameter("$1", $2, $3, $4, $5)' },
            { name: 'Prepared',        doc: 'Whether to save a compiled version of the command.' },
        ]
    },
    'scripting.dictionary': {
        label: 'Scripting.Dictionary',
        members: [
            { name: 'Add',         doc: 'Adds a new key/value pair.',     snippet: 'Add "$1", $2' },
            { name: 'Remove',      doc: 'Removes a key/value pair.',      snippet: 'Remove("$0")' },
            { name: 'RemoveAll',   doc: 'Removes all key/value pairs.',   snippet: 'RemoveAll()' },
            { name: 'Exists',      doc: 'Returns True if the key exists.', snippet: 'Exists("$0")' },
            { name: 'Item',        doc: 'Gets or sets the value for a key.', snippet: 'Item("$0")' },
            { name: 'Items',       doc: 'Returns an array of all values.',  snippet: 'Items()' },
            { name: 'Keys',        doc: 'Returns an array of all keys.',    snippet: 'Keys()' },
            { name: 'Count',       doc: 'Number of key/value pairs in the dictionary.' },
            { name: 'CompareMode', doc: 'Comparison mode for string keys (0=Binary, 1=Text).' },
        ]
    },
    'scripting.filesystemobject': {
        label: 'Scripting.FileSystemObject',
        members: [
            { name: 'CreateTextFile',   doc: 'Creates a text file.',          snippet: 'CreateTextFile("$1", $2)' },
            { name: 'OpenTextFile',     doc: 'Opens a text file.',            snippet: 'OpenTextFile("$1", $2)' },
            { name: 'FileExists',       doc: 'Returns True if the file exists.', snippet: 'FileExists("$0")' },
            { name: 'FolderExists',     doc: 'Returns True if the folder exists.', snippet: 'FolderExists("$0")' },
            { name: 'DeleteFile',       doc: 'Deletes a file.',               snippet: 'DeleteFile("$0")' },
            { name: 'DeleteFolder',     doc: 'Deletes a folder.',             snippet: 'DeleteFolder("$0")' },
            { name: 'CopyFile',         doc: 'Copies a file.',                snippet: 'CopyFile "$1", "$2"' },
            { name: 'MoveFile',         doc: 'Moves a file.',                 snippet: 'MoveFile "$1", "$2"' },
            { name: 'GetFile',          doc: 'Returns a File object.',        snippet: 'GetFile("$0")' },
            { name: 'GetFolder',        doc: 'Returns a Folder object.',      snippet: 'GetFolder("$0")' },
            { name: 'GetFileName',      doc: 'Returns just the file name from a path.', snippet: 'GetFileName("$0")' },
            { name: 'GetParentFolderName', doc: 'Returns the parent folder path.', snippet: 'GetParentFolderName("$0")' },
            { name: 'BuildPath',        doc: 'Combines a path and a name.',   snippet: 'BuildPath("$1", "$2")' },
        ]
    },
    'msxml2.domdocument': {
        label: 'MSXML2.DOMDocument',
        members: [
            { name: 'Load',            doc: 'Loads XML from a file.',       snippet: 'Load("$0")' },
            { name: 'LoadXML',         doc: 'Loads XML from a string.',     snippet: 'LoadXML($0)' },
            { name: 'Save',            doc: 'Saves the XML document.',      snippet: 'Save("$0")' },
            { name: 'SelectNodes',     doc: 'Selects nodes matching an XPath.', snippet: 'SelectNodes("$0")' },
            { name: 'SelectSingleNode', doc: 'Selects a single node by XPath.', snippet: 'SelectSingleNode("$0")' },
            { name: 'CreateElement',   doc: 'Creates a new element node.',  snippet: 'CreateElement("$0")' },
            { name: 'CreateTextNode',  doc: 'Creates a new text node.',     snippet: 'CreateTextNode($0)' },
            { name: 'DocumentElement', doc: 'The root element of the document.' },
            { name: 'XML',             doc: 'String representation of the document XML.' },
            { name: 'ParseError',      doc: 'Error object from last parse operation.' },
        ]
    },
    'msxml2.serverxmlhttp': {
        label: 'MSXML2.ServerXMLHTTP',
        members: [
            { name: 'Open',            doc: 'Initialises the request.',     snippet: 'Open "$1", "$2", False' },
            { name: 'Send',            doc: 'Sends the HTTP request.',      snippet: 'Send($0)' },
            { name: 'SetRequestHeader', doc: 'Sets an HTTP request header.', snippet: 'SetRequestHeader "$1", "$2"' },
            { name: 'GetResponseHeader', doc: 'Gets a response header.',    snippet: 'GetResponseHeader("$0")' },
            { name: 'ResponseText',    doc: 'Response body as a string.' },
            { name: 'ResponseXML',     doc: 'Response body as an XML document.' },
            { name: 'Status',          doc: 'HTTP status code (e.g. 200).' },
            { name: 'StatusText',      doc: 'HTTP status text (e.g. "OK").' },
        ]
    },
    'wscript.shell': {
        label: 'WScript.Shell',
        members: [
            { name: 'Run',             doc: 'Runs a program.',              snippet: 'Run "$1", $2, $3' },
            { name: 'Exec',            doc: 'Executes a command and returns a process.',  snippet: 'Exec("$0")' },
            { name: 'ExpandEnvironmentStrings', doc: 'Expands environment variable strings.', snippet: 'ExpandEnvironmentStrings("$0")' },
            { name: 'RegRead',         doc: 'Reads a value from the registry.',  snippet: 'RegRead("$0")' },
            { name: 'RegWrite',        doc: 'Writes a value to the registry.',   snippet: 'RegWrite "$1", $2' },
            { name: 'RegDelete',       doc: 'Deletes a key from the registry.',  snippet: 'RegDelete("$0")' },
            { name: 'Environment',     doc: 'Environment variables collection.',  snippet: 'Environment("$0")' },
        ]
    },
};

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