/**
 * comObjects.ts  (constants/)
 *
 * Single source of truth for all COM object type definitions.
 * Replaces the separate COM_TYPE_MAP in aspCompletionProvider.ts and the
 * registerComMembers() / COM_MEMBER_DOCS block in aspHoverProvider.ts.
 *
 * Exports:
 *   COM_TYPE_MAP     — used by aspCompletionProvider for member completions
 *   COM_MEMBER_DOCS  — used by aspHoverProvider for hover documentation
 *
 * The two are derived from the same raw data so they can never drift apart.
 * Docs come from aspHoverProvider (richer). Snippets come from aspCompletionProvider.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Raw source data
// ─────────────────────────────────────────────────────────────────────────────

interface ComMember {
    name: string;
    doc: string;
    snippet?: string;
}

interface ComTypeDef {
    label: string;
    members: ComMember[];
}

const COM_RAW: Record<string, ComTypeDef> = {

    'adodb.recordset': {
        label: 'ADODB.Recordset',
        members: [
            { name: 'EOF',              doc: '`True` when the cursor is past the last record. Used in `Do While Not rs.EOF` loops.' },
            { name: 'BOF',              doc: '`True` when the cursor is before the first record.' },
            { name: 'Open',             doc: 'Opens the recordset using a SQL query and a connection.',            snippet: 'Open($0)' },
            { name: 'Close',            doc: 'Closes the recordset and releases its resources.',                   snippet: 'Close()' },
            { name: 'MoveNext',         doc: 'Advances the cursor to the next record.',                            snippet: 'MoveNext()' },
            { name: 'MovePrev',         doc: 'Moves the cursor back to the previous record.',                      snippet: 'MovePrev()' },
            { name: 'MoveFirst',        doc: 'Moves the cursor to the first record.',                              snippet: 'MoveFirst()' },
            { name: 'MoveLast',         doc: 'Moves the cursor to the last record.',                               snippet: 'MoveLast()' },
            { name: 'AddNew',           doc: 'Prepares a new record for editing.',                                 snippet: 'AddNew()' },
            { name: 'Update',           doc: 'Saves changes made to the current record.',                          snippet: 'Update()' },
            { name: 'Delete',           doc: 'Deletes the current record.',                                        snippet: 'Delete()' },
            { name: 'Fields',           doc: 'Collection of Field objects. Access with `rs.Fields("ColumnName")` or `rs("ColumnName")`.', snippet: 'Fields("$0")' },
            { name: 'RecordCount',      doc: 'Total number of records. May return -1 for forward-only cursors.' },
            { name: 'PageSize',         doc: 'Number of records per page for paged navigation.' },
            { name: 'PageCount',        doc: 'Total number of pages based on PageSize.' },
            { name: 'AbsolutePage',     doc: 'Gets or sets the current page number.' },
            { name: 'AbsolutePosition', doc: 'Gets or sets the ordinal position of the current record.' },
            { name: 'CursorType',       doc: 'Type of cursor (0=ForwardOnly, 1=Keyset, 2=Dynamic, 3=Static).' },
            { name: 'LockType',         doc: 'Type of lock (1=ReadOnly, 2=Pessimistic, 3=Optimistic, 4=BatchOptimistic).' },
            { name: 'ActiveConnection', doc: 'The connection used by this recordset.' },
            { name: 'Source',           doc: 'The SQL statement or table name used to populate the recordset.' },
        ],
    },

    'adodb.connection': {
        label: 'ADODB.Connection',
        members: [
            { name: 'Open',               doc: 'Opens a connection to a database using the ConnectionString.',       snippet: 'Open("$0")' },
            { name: 'Close',              doc: 'Closes the database connection.',                                    snippet: 'Close()' },
            { name: 'Execute',            doc: 'Executes a SQL command and optionally returns a Recordset.',         snippet: 'Execute("$0")' },
            { name: 'BeginTrans',         doc: 'Begins a new transaction.',                                          snippet: 'BeginTrans()' },
            { name: 'CommitTrans',        doc: 'Commits all changes made during the current transaction.',           snippet: 'CommitTrans()' },
            { name: 'RollbackTrans',      doc: 'Rolls back all changes made during the current transaction.',        snippet: 'RollbackTrans()' },
            { name: 'ConnectionString',   doc: 'The string used to establish the database connection.' },
            { name: 'CommandTimeout',     doc: 'Number of seconds to wait before timing out a command. Default is 30.' },
            { name: 'ConnectionTimeout',  doc: 'Number of seconds to wait while establishing a connection.' },
            { name: 'Errors',             doc: 'Collection of Error objects from the last operation.' },
            { name: 'State',              doc: '0 = Closed, 1 = Open.' },
            { name: 'CursorLocation',     doc: '2 = Server-side cursor, 3 = Client-side cursor.' },
        ],
    },

    'adodb.command': {
        label: 'ADODB.Command',
        members: [
            { name: 'Execute',          doc: 'Executes the command defined in CommandText.',                         snippet: 'Execute()' },
            { name: 'ActiveConnection', doc: 'The connection this command runs against.' },
            { name: 'CommandText',      doc: 'The SQL statement or stored procedure name.' },
            { name: 'CommandType',      doc: '1=Text, 2=Table, 4=StoredProc, 8=Unknown.' },
            { name: 'CommandTimeout',   doc: 'Seconds to wait before timing out. Default is 30.' },
            { name: 'Parameters',       doc: 'Collection of Parameter objects for parameterised queries.',           snippet: 'Parameters.Append $0' },
            { name: 'CreateParameter',  doc: 'Creates a new Parameter object. Args: name, type, direction, size, value.', snippet: 'CreateParameter("$1", $2, $3, $4, $5)' },
            { name: 'Prepared',         doc: 'If True, the provider saves a compiled version of the command on first execute.' },
        ],
    },

    'scripting.dictionary': {
        label: 'Scripting.Dictionary',
        members: [
            { name: 'Add',         doc: 'Adds a key/value pair. Errors if the key already exists.',       snippet: 'Add "$1", $2' },
            { name: 'Remove',      doc: 'Removes the entry for a given key.',                             snippet: 'Remove("$0")' },
            { name: 'RemoveAll',   doc: 'Removes all key/value pairs from the dictionary.',               snippet: 'RemoveAll()' },
            { name: 'Exists',      doc: 'Returns `True` if the specified key exists.',                    snippet: 'Exists("$0")' },
            { name: 'Item',        doc: 'Gets or sets the value associated with a key.',                  snippet: 'Item("$0")' },
            { name: 'Items',       doc: 'Returns an array of all values.',                                snippet: 'Items()' },
            { name: 'Keys',        doc: 'Returns an array of all keys.',                                  snippet: 'Keys()' },
            { name: 'Count',       doc: 'Number of key/value pairs currently in the dictionary.' },
            { name: 'CompareMode', doc: '0 = Binary (case-sensitive), 1 = Text (case-insensitive).' },
        ],
    },

    'scripting.filesystemobject': {
        label: 'Scripting.FileSystemObject',
        members: [
            { name: 'CreateTextFile',        doc: 'Creates a new text file and returns a TextStream object.',        snippet: 'CreateTextFile("$1", $2)' },
            { name: 'OpenTextFile',          doc: 'Opens a file and returns a TextStream. Mode: 1=Read, 2=Write, 8=Append.', snippet: 'OpenTextFile("$1", $2)' },
            { name: 'FileExists',            doc: 'Returns `True` if the specified file exists.',                    snippet: 'FileExists("$0")' },
            { name: 'FolderExists',          doc: 'Returns `True` if the specified folder exists.',                  snippet: 'FolderExists("$0")' },
            { name: 'DeleteFile',            doc: 'Deletes the specified file.',                                     snippet: 'DeleteFile("$0")' },
            { name: 'DeleteFolder',          doc: 'Deletes the specified folder and its contents.',                  snippet: 'DeleteFolder("$0")' },
            { name: 'CopyFile',              doc: 'Copies a file from source to destination.',                       snippet: 'CopyFile "$1", "$2"' },
            { name: 'MoveFile',              doc: 'Moves a file from source to destination.',                        snippet: 'MoveFile "$1", "$2"' },
            { name: 'GetFile',               doc: 'Returns a File object for the given path.',                       snippet: 'GetFile("$0")' },
            { name: 'GetFolder',             doc: 'Returns a Folder object for the given path.',                     snippet: 'GetFolder("$0")' },
            { name: 'GetFileName',           doc: 'Returns just the filename portion of a full path.',               snippet: 'GetFileName("$0")' },
            { name: 'GetParentFolderName',   doc: 'Returns the parent folder path.',                                 snippet: 'GetParentFolderName("$0")' },
            { name: 'BuildPath',             doc: 'Appends a name to an existing path.',                             snippet: 'BuildPath("$1", "$2")' },
        ],
    },

    'msxml2.domdocument': {
        label: 'MSXML2.DOMDocument',
        members: [
            { name: 'Load',             doc: 'Loads XML from a file.',                                              snippet: 'Load("$0")' },
            { name: 'LoadXML',          doc: 'Loads XML from a string.',                                            snippet: 'LoadXML($0)' },
            { name: 'Save',             doc: 'Saves the XML document.',                                             snippet: 'Save("$0")' },
            { name: 'SelectNodes',      doc: 'Selects nodes matching an XPath.',                                    snippet: 'SelectNodes("$0")' },
            { name: 'SelectSingleNode', doc: 'Selects a single node by XPath.',                                     snippet: 'SelectSingleNode("$0")' },
            { name: 'CreateElement',    doc: 'Creates a new element node.',                                         snippet: 'CreateElement("$0")' },
            { name: 'CreateTextNode',   doc: 'Creates a new text node.',                                            snippet: 'CreateTextNode($0)' },
            { name: 'DocumentElement',  doc: 'The root element of the document.' },
            { name: 'XML',              doc: 'String representation of the document XML.' },
            { name: 'ParseError',       doc: 'Error object from last parse operation.' },
        ],
    },

    'msxml2.serverxmlhttp': {
        label: 'MSXML2.ServerXMLHTTP',
        members: [
            { name: 'Open',              doc: 'Initialises the request.',                                           snippet: 'Open "$1", "$2", False' },
            { name: 'Send',              doc: 'Sends the HTTP request.',                                            snippet: 'Send($0)' },
            { name: 'SetRequestHeader',  doc: 'Sets an HTTP request header.',                                       snippet: 'SetRequestHeader "$1", "$2"' },
            { name: 'GetResponseHeader', doc: 'Gets a response header.',                                            snippet: 'GetResponseHeader("$0")' },
            { name: 'ResponseText',      doc: 'Response body as a string.' },
            { name: 'ResponseXML',       doc: 'Response body as an XML document.' },
            { name: 'Status',            doc: 'HTTP status code (e.g. 200).' },
            { name: 'StatusText',        doc: 'HTTP status text (e.g. "OK").' },
        ],
    },

    'wscript.shell': {
        label: 'WScript.Shell',
        members: [
            { name: 'Run',                          doc: 'Runs a program.',                                          snippet: 'Run "$1", $2, $3' },
            { name: 'Exec',                         doc: 'Executes a command and returns a process object.',         snippet: 'Exec("$0")' },
            { name: 'ExpandEnvironmentStrings',     doc: 'Expands environment variable strings.',                    snippet: 'ExpandEnvironmentStrings("$0")' },
            { name: 'RegRead',                      doc: 'Reads a value from the registry.',                         snippet: 'RegRead("$0")' },
            { name: 'RegWrite',                     doc: 'Writes a value to the registry.',                          snippet: 'RegWrite "$1", $2' },
            { name: 'RegDelete',                    doc: 'Deletes a key from the registry.',                         snippet: 'RegDelete("$0")' },
            { name: 'Environment',                  doc: 'Environment variables collection.',                        snippet: 'Environment("$0")' },
        ],
    },

};

// ─────────────────────────────────────────────────────────────────────────────
// COM_TYPE_MAP — used by aspCompletionProvider
// Shape: Record<progId, { label, members[] }>
// ─────────────────────────────────────────────────────────────────────────────
export const COM_TYPE_MAP: Record<string, { label: string; members: { name: string; doc: string; snippet?: string }[] }> = COM_RAW;

// ─────────────────────────────────────────────────────────────────────────────
// COM_MEMBER_DOCS — used by aspHoverProvider
// Shape: Record<"progid.membername", { label, doc }>  (all lowercase key)
// ─────────────────────────────────────────────────────────────────────────────
export const COM_MEMBER_DOCS: Record<string, { label: string; doc: string }> = {};

for (const [progId, typeDef] of Object.entries(COM_RAW)) {
    for (const member of typeDef.members) {
        COM_MEMBER_DOCS[`${progId}.${member.name.toLowerCase()}`] = {
            label: `${typeDef.label}.${member.name}`,
            doc:   member.doc,
        };
    }
}