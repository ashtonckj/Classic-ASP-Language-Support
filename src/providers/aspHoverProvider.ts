import * as vscode from 'vscode';
import { collectAllSymbols } from './includeProvider';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// COM member documentation — same members as in aspCompletionProvider.
// Keyed as "progid.membername" (all lowercase) for fast lookup.
// ─────────────────────────────────────────────────────────────────────────────
const COM_MEMBER_DOCS: Record<string, { label: string; doc: string }> = {};

function registerComMembers(progId: string, label: string, members: { name: string; doc: string }[]) {
    for (const m of members) {
        COM_MEMBER_DOCS[`${progId}.${m.name.toLowerCase()}`] = { label: `${label}.${m.name}`, doc: m.doc };
    }
}

registerComMembers('adodb.recordset', 'ADODB.Recordset', [
    { name: 'EOF',              doc: '`True` when the cursor is past the last record. Used in `Do While Not rs.EOF` loops.' },
    { name: 'BOF',              doc: '`True` when the cursor is before the first record.' },
    { name: 'Open',             doc: 'Opens the recordset using a SQL query and a connection.' },
    { name: 'Close',            doc: 'Closes the recordset and releases its resources.' },
    { name: 'MoveNext',         doc: 'Advances the cursor to the next record.' },
    { name: 'MovePrev',         doc: 'Moves the cursor back to the previous record.' },
    { name: 'MoveFirst',        doc: 'Moves the cursor to the first record.' },
    { name: 'MoveLast',         doc: 'Moves the cursor to the last record.' },
    { name: 'AddNew',           doc: 'Prepares a new record for editing.' },
    { name: 'Update',           doc: 'Saves changes made to the current record.' },
    { name: 'Delete',           doc: 'Deletes the current record.' },
    { name: 'Fields',           doc: 'Collection of Field objects. Access with `rs.Fields("ColumnName")` or `rs("ColumnName")`.' },
    { name: 'RecordCount',      doc: 'Total number of records. May return -1 for forward-only cursors.' },
    { name: 'PageSize',         doc: 'Number of records per page for paged navigation.' },
    { name: 'PageCount',        doc: 'Total number of pages based on PageSize.' },
    { name: 'AbsolutePage',     doc: 'Gets or sets the current page number.' },
    { name: 'AbsolutePosition', doc: 'Gets or sets the ordinal position of the current record.' },
    { name: 'CursorType',       doc: 'Type of cursor (0=ForwardOnly, 1=Keyset, 2=Dynamic, 3=Static).' },
    { name: 'LockType',         doc: 'Type of lock (1=ReadOnly, 2=Pessimistic, 3=Optimistic, 4=BatchOptimistic).' },
    { name: 'ActiveConnection', doc: 'The connection used by this recordset.' },
    { name: 'Source',           doc: 'The SQL statement or table name used to populate the recordset.' },
]);

registerComMembers('adodb.connection', 'ADODB.Connection', [
    { name: 'Open',               doc: 'Opens a connection to a database using the ConnectionString.' },
    { name: 'Close',              doc: 'Closes the database connection.' },
    { name: 'Execute',            doc: 'Executes a SQL command and optionally returns a Recordset.' },
    { name: 'BeginTrans',         doc: 'Begins a new transaction.' },
    { name: 'CommitTrans',        doc: 'Commits all changes made during the current transaction.' },
    { name: 'RollbackTrans',      doc: 'Rolls back all changes made during the current transaction.' },
    { name: 'ConnectionString',   doc: 'The string used to establish the database connection.' },
    { name: 'CommandTimeout',     doc: 'Number of seconds to wait before timing out a command. Default is 30.' },
    { name: 'ConnectionTimeout',  doc: 'Number of seconds to wait while establishing a connection.' },
    { name: 'Errors',             doc: 'Collection of Error objects from the last operation.' },
    { name: 'State',              doc: '0 = Closed, 1 = Open.' },
    { name: 'CursorLocation',     doc: '2 = Server-side cursor, 3 = Client-side cursor.' },
]);

registerComMembers('adodb.command', 'ADODB.Command', [
    { name: 'Execute',          doc: 'Executes the command defined in CommandText.' },
    { name: 'ActiveConnection', doc: 'The connection this command runs against.' },
    { name: 'CommandText',      doc: 'The SQL statement or stored procedure name.' },
    { name: 'CommandType',      doc: '1=Text, 2=Table, 4=StoredProc, 8=Unknown.' },
    { name: 'CommandTimeout',   doc: 'Seconds to wait before timing out. Default is 30.' },
    { name: 'Parameters',       doc: 'Collection of Parameter objects for parameterised queries.' },
    { name: 'CreateParameter',  doc: 'Creates a new Parameter object. Args: name, type, direction, size, value.' },
    { name: 'Prepared',         doc: 'If True, the provider saves a compiled version of the command on first execute.' },
]);

registerComMembers('scripting.dictionary', 'Scripting.Dictionary', [
    { name: 'Add',         doc: 'Adds a key/value pair. Errors if the key already exists.' },
    { name: 'Remove',      doc: 'Removes the entry for a given key.' },
    { name: 'RemoveAll',   doc: 'Removes all key/value pairs from the dictionary.' },
    { name: 'Exists',      doc: 'Returns `True` if the specified key exists.' },
    { name: 'Item',        doc: 'Gets or sets the value associated with a key.' },
    { name: 'Items',       doc: 'Returns an array of all values.' },
    { name: 'Keys',        doc: 'Returns an array of all keys.' },
    { name: 'Count',       doc: 'Number of key/value pairs currently in the dictionary.' },
    { name: 'CompareMode', doc: '0 = Binary (case-sensitive), 1 = Text (case-insensitive).' },
]);

registerComMembers('scripting.filesystemobject', 'Scripting.FileSystemObject', [
    { name: 'CreateTextFile',        doc: 'Creates a new text file and returns a TextStream object.' },
    { name: 'OpenTextFile',          doc: 'Opens a file and returns a TextStream. Mode: 1=Read, 2=Write, 8=Append.' },
    { name: 'FileExists',            doc: 'Returns `True` if the specified file exists.' },
    { name: 'FolderExists',          doc: 'Returns `True` if the specified folder exists.' },
    { name: 'DeleteFile',            doc: 'Deletes the specified file.' },
    { name: 'DeleteFolder',          doc: 'Deletes the specified folder and its contents.' },
    { name: 'CopyFile',              doc: 'Copies a file from source to destination.' },
    { name: 'MoveFile',              doc: 'Moves a file from source to destination.' },
    { name: 'GetFile',               doc: 'Returns a File object for the given path.' },
    { name: 'GetFolder',             doc: 'Returns a Folder object for the given path.' },
    { name: 'GetFileName',           doc: 'Returns just the filename portion of a full path.' },
    { name: 'GetParentFolderName',   doc: 'Returns the parent folder path.' },
    { name: 'BuildPath',             doc: 'Appends a name to an existing path.' },
]);

// ─────────────────────────────────────────────────────────────────────────────
// VBScript keyword docs for hover
// ─────────────────────────────────────────────────────────────────────────────
const KEYWORD_DOCS: Record<string, string> = {
    'dim':        '**Dim** — Declares one or more variables.\n\nExample: `Dim name, age`',
    'redim':      '**ReDim** — Resizes a dynamic array.\n\nExample: `ReDim arr(10)`',
    'set':        '**Set** — Assigns an object reference to a variable.\n\nExample: `Set rs = Server.CreateObject("ADODB.Recordset")`',
    'const':      '**Const** — Declares a constant value that cannot change.\n\nExample: `Const MAX = 100`',
    'if':         '**If** — Conditional statement.\n\nExample: `If x > 0 Then ... End If`',
    'for':        '**For** — Counter-based loop.\n\nExample: `For i = 1 To 10 ... Next`',
    'for each':   '**For Each** — Iterates over a collection.\n\nExample: `For Each item In collection ... Next`',
    'do':         '**Do** — Repeating loop.\n\nExample: `Do While Not rs.EOF ... Loop`',
    'while':      '**While** — Condition-based loop.\n\nExample: `While condition ... Wend`',
    'function':   '**Function** — Declares a function that returns a value.\n\nExample: `Function GetName(id) ... End Function`',
    'sub':        '**Sub** — Declares a subroutine that does not return a value.\n\nExample: `Sub ConnectDb() ... End Sub`',
    'select case':'**Select Case** — Multi-branch conditional.\n\nExample: `Select Case x ... Case 1 ... End Select`',
    'with':       '**With** — Shorthand for repeated access to an object\'s members.\n\nExample: `With rs ... .MoveNext ... End With`',
    'on error resume next': '**On Error Resume Next** — Suppresses runtime errors and continues execution. Always check `Err.Number` after suspicious calls.',
    'option explicit': '**Option Explicit** — Forces all variables to be declared with `Dim`. Recommended to prevent typo bugs.',
};

// ─────────────────────────────────────────────────────────────────────────────
// Hover provider
// Shows docs when hovering over:
//   • User-defined Function/Sub names (from this file or includes)
//   • User-defined variables and constants
//   • COM object variables (rs, conn, dict, etc.)
//   • COM member names after a dot (rs.EOF, conn.Execute, etc.)
//   • VBScript keywords
// ─────────────────────────────────────────────────────────────────────────────
export class AspHoverProvider implements vscode.HoverProvider {

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Hover> {

        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) return null;

        const word     = document.getText(wordRange);
        const wordKey  = word.toLowerCase();
        const lineText = document.lineAt(position.line).text;

        // ── 1. COM member after dot — e.g. rs.EOF, conn.Execute ──────────────
        // Check if there's a dot immediately before the word
        const charBeforeWord = lineText.charAt(wordRange.start.character - 1);
        if (charBeforeWord === '.') {
            // Find the object name before the dot
            const textBeforeDot = lineText.substring(0, wordRange.start.character - 1);
            const objMatch      = textBeforeDot.match(/\b(\w+)$/);
            if (objMatch) {
                const objName  = objMatch[1].toLowerCase();
                const allSymbols = collectAllSymbols(document);

                // Find which COM type this object is
                const comVar = allSymbols.comVariables.find(cv => cv.name.toLowerCase() === objName);
                if (comVar) {
                    const key     = `${comVar.progId}.${wordKey}`;
                    const memberDoc = COM_MEMBER_DOCS[key];
                    if (memberDoc) {
                        return new vscode.Hover(
                            new vscode.MarkdownString(`**${memberDoc.label}**\n\n${memberDoc.doc}`)
                        );
                    }
                }
            }
        }

        // ── 2. User-defined Function or Sub ───────────────────────────────────
        const allSymbols = collectAllSymbols(document);
        const fn = allSymbols.functions.find(f => f.name.toLowerCase() === wordKey);
        if (fn) {
            const fromInclude = fn.filePath !== document.uri.fsPath;
            const header      = fn.params
                ? `**${fn.kind} ${fn.name}(${fn.params})**`
                : `**${fn.kind} ${fn.name}**`;
            const source      = fromInclude
                ? `\n\n*Defined in \`${path.basename(fn.filePath)}\`*`
                : `\n\n*Defined in this file*`;
            return new vscode.Hover(new vscode.MarkdownString(header + source));
        }

        // ── 3. COM object variable (rs, conn, dict, etc.) ─────────────────────
        const comVar = allSymbols.comVariables.find(cv => cv.name.toLowerCase() === wordKey);
        if (comVar) {
            const fromInclude = comVar.filePath !== document.uri.fsPath;
            const source      = fromInclude
                ? `*Declared in \`${path.basename(comVar.filePath)}\`*`
                : `*Declared in this file*`;
            return new vscode.Hover(
                new vscode.MarkdownString(
                    `**${comVar.name}** — \`${comVar.progId}\`\n\n${source}\n\nType \`${comVar.name}.\` to see available members.`
                )
            );
        }

        // ── 4. User-defined variable ──────────────────────────────────────────
        const variable = allSymbols.variables.find(v => v.name.toLowerCase() === wordKey);
        if (variable) {
            const fromInclude = variable.filePath !== document.uri.fsPath;
            const source      = fromInclude
                ? `*Declared in \`${path.basename(variable.filePath)}\`*`
                : `*Declared in this file*`;
            return new vscode.Hover(new vscode.MarkdownString(`**${variable.name}** — variable\n\n${source}`));
        }

        // ── 5. User-defined constant ──────────────────────────────────────────
        const constant = allSymbols.constants.find(c => c.name.toLowerCase() === wordKey);
        if (constant) {
            const fromInclude = constant.filePath !== document.uri.fsPath;
            const source      = fromInclude
                ? `*Declared in \`${path.basename(constant.filePath)}\`*`
                : `*Declared in this file*`;
            return new vscode.Hover(
                new vscode.MarkdownString(`**${constant.name}** = \`${constant.value}\`\n\n${source}`)
            );
        }

        // ── 6. VBScript keywords ──────────────────────────────────────────────
        if (KEYWORD_DOCS[wordKey]) {
            return new vscode.Hover(new vscode.MarkdownString(KEYWORD_DOCS[wordKey]));
        }

        return null;
    }
}