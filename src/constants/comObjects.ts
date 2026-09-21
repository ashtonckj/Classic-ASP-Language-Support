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
 *
 * ── What belongs here ───────────────────────────────────────────────────────
 * The components that ship with Windows and IIS and turn up in ordinary pages:
 * ADO, the Scripting runtime, MSXML, CDO for mail, and WScript.Shell. A COM
 * component is by definition open-ended — anyone can register their own — so
 * the boundary is "installed on the server already", not "every ProgID".
 *
 * An unknown ProgID is not merely uncovered, it is worse off than an untyped
 * variable: `aspCompletionProvider` returns an EMPTY list for a dotted access
 * it cannot resolve, deliberately, so that keywords do not pollute a member
 * list. That is why the types named by COM_METHOD_RETURN_TYPES have to exist —
 * inferring `Set ts = fso.OpenTextFile(p)` as a TextStream and then having no
 * TextStream left `ts.` offering nothing at all.
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
            { name: 'EOF',              doc: '`True` when the cursor is past the last record.' },
            { name: 'BOF',              doc: '`True` when the cursor is before the first record.' },
            { name: 'Open',             doc: 'Opens the recordset using a SQL query and a connection.',   snippet: 'Open $0' },
            { name: 'Close',            doc: 'Closes the recordset and releases its resources.' },
            { name: 'MoveNext',         doc: 'Advances the cursor to the next record.' },
            { name: 'MovePrevious',     doc: 'Moves the cursor back to the previous record. Needs a cursor that is not forward-only.' },
            { name: 'MoveFirst',        doc: 'Moves the cursor to the first record.' },
            { name: 'MoveLast',         doc: 'Moves the cursor to the last record.' },
            { name: 'Move',             doc: 'Moves the cursor by a number of records, forwards or backwards.',   snippet: 'Move $0' },
            { name: 'AddNew',           doc: 'Prepares a new record for editing.' },
            { name: 'Update',           doc: 'Saves changes made to the current record.' },
            { name: 'CancelUpdate',     doc: 'Discards changes made to the current record before Update.' },
            { name: 'UpdateBatch',      doc: 'Writes every pending change at once. For a batch-optimistic lock.' },
            { name: 'Delete',           doc: 'Deletes the current record.' },
            { name: 'Requery',          doc: 'Runs the source query again and refreshes the contents.' },
            { name: 'Fields',           doc: 'Collection of Field objects.',                              snippet: 'Fields("$0")' },
            { name: 'GetRows',          doc: 'Copies records into a two-dimensional array — `arr(column, row)`. Much faster than looping the recordset.', snippet: 'GetRows()' },
            { name: 'GetString',        doc: 'Returns the whole recordset as one delimited string.',       snippet: 'GetString()' },
            { name: 'NextRecordset',    doc: 'Moves to the next result set, when the command returned several.', snippet: 'NextRecordset()' },
            { name: 'Supports',         doc: 'Tests whether the recordset supports a feature, e.g. `Supports(&H01000400)` for bookmarks.', snippet: 'Supports($0)' },
            { name: 'Filter',           doc: 'Restricts the visible records to those matching a criteria string. `""` clears it.' },
            { name: 'Sort',             doc: 'Orders the records by one or more fields. Needs a client-side cursor.' },
            { name: 'Bookmark',         doc: 'Gets or sets a marker for the current record, so it can be returned to.' },
            { name: 'RecordCount',      doc: 'Total number of records. Returns -1 for a forward-only cursor.' },
            { name: 'PageSize',         doc: 'Number of records per page for paged navigation.' },
            { name: 'PageCount',        doc: 'Total number of pages based on PageSize.' },
            { name: 'AbsolutePage',     doc: 'Gets or sets the current page number.' },
            { name: 'AbsolutePosition', doc: 'Gets or sets the ordinal position of the current record.' },
            { name: 'CursorType',       doc: 'Type of cursor (0=ForwardOnly, 1=Keyset, 2=Dynamic, 3=Static).' },
            { name: 'CursorLocation',   doc: '2 = Server-side cursor, 3 = Client-side. Paging, Sort and RecordCount need 3.' },
            { name: 'LockType',         doc: 'Type of lock (1=ReadOnly, 2=Pessimistic, 3=Optimistic, 4=BatchOptimistic).' },
            { name: 'MaxRecords',       doc: 'Caps how many records the source query may return. `0` means no limit.' },
            { name: 'CacheSize',        doc: 'How many records are held in local memory at a time.' },
            { name: 'State',            doc: '0 = Closed, 1 = Open.' },
            { name: 'EditMode',         doc: '0 = None, 1 = In edit, 2 = Added but not yet saved.' },
            { name: 'ActiveConnection', doc: 'The connection used by this recordset.' },
            { name: 'Source',           doc: 'The SQL statement or table name used to populate the recordset.' },
            { name: 'Properties',       doc: 'Provider-specific properties of the recordset.' },
        ],
    },

    'adodb.connection': {
        label: 'ADODB.Connection',
        members: [
            { name: 'Open',               doc: 'Opens a connection to a database.',                       snippet: 'Open "$0"' },
            { name: 'Close',              doc: 'Closes the database connection.' },
            { name: 'Execute',            doc: 'Executes a SQL command and optionally returns a Recordset.', snippet: 'Execute("$0")' },
            { name: 'Cancel',             doc: 'Cancels an asynchronous Execute or Open still in progress.' },
            { name: 'OpenSchema',         doc: 'Returns a recordset of database metadata — tables, columns, keys.', snippet: 'OpenSchema($0)' },
            { name: 'BeginTrans',         doc: 'Begins a new transaction.' },
            { name: 'CommitTrans',        doc: 'Commits all changes made during the current transaction.' },
            { name: 'RollbackTrans',      doc: 'Rolls back all changes made during the current transaction.' },
            { name: 'ConnectionString',   doc: 'The string used to establish the database connection.' },
            { name: 'Provider',           doc: 'The OLE DB provider name, e.g. `"SQLOLEDB"` or `"Microsoft.Jet.OLEDB.4.0"`.' },
            { name: 'DefaultDatabase',    doc: 'The database used for commands that do not name one.' },
            { name: 'CommandTimeout',     doc: 'Number of seconds to wait before timing out a command. Default is 30.' },
            { name: 'ConnectionTimeout',  doc: 'Number of seconds to wait while establishing a connection.' },
            { name: 'IsolationLevel',     doc: 'The transaction isolation level for transactions on this connection.' },
            { name: 'Mode',               doc: 'Read/write permissions for the connection.' },
            { name: 'Attributes',         doc: 'Whether a commit or rollback automatically starts a new transaction.' },
            { name: 'Errors',             doc: 'Collection of Error objects from the last operation.',     snippet: 'Errors($0)' },
            { name: 'State',              doc: '0 = Closed, 1 = Open.' },
            { name: 'Version',            doc: 'Read-only. The ADO version string.' },
            { name: 'CursorLocation',     doc: '2 = Server-side cursor, 3 = Client-side cursor.' },
            { name: 'Properties',         doc: 'Provider-specific properties of the connection.' },
        ],
    },

    'adodb.command': {
        label: 'ADODB.Command',
        members: [
            { name: 'Execute',          doc: 'Executes the command defined in CommandText.',                         snippet: 'Execute()' },
            { name: 'Cancel',           doc: 'Cancels an asynchronous Execute still in progress.' },
            { name: 'ActiveConnection', doc: 'The connection this command runs against.' },
            { name: 'CommandText',      doc: 'The SQL statement or stored procedure name.' },
            { name: 'CommandType',      doc: '1=Text, 2=Table, 4=StoredProc, 8=Unknown. Setting it saves ADO a round trip.' },
            { name: 'CommandTimeout',   doc: 'Seconds to wait before timing out. Default is 30.' },
            { name: 'Parameters',       doc: 'Collection of Parameter objects for parameterised queries.',           snippet: 'Parameters.Append $0' },
            { name: 'CreateParameter',  doc: 'Creates a new Parameter object. Args: name, type, direction, size, value.', snippet: 'CreateParameter("$1", $2, $3, $4, $5)' },
            { name: 'Prepared',         doc: 'If True, the provider saves a compiled version of the command on first execute.' },
            { name: 'Name',             doc: 'A name for the command, so it can be called as a method of the Connection.' },
            { name: 'State',            doc: '0 = Closed, 1 = Open.' },
            { name: 'Properties',       doc: 'Provider-specific properties of the command.' },
        ],
    },

    // Reached through `rs.Fields("name")` and through a Command's Parameters.
    'adodb.field': {
        label: 'ADODB.Field',
        members: [
            { name: 'Value',           doc: 'The data in the field. This is the default member, so `rs("name")` and `rs.Fields("name").Value` are the same thing.' },
            { name: 'Name',            doc: 'The column name.' },
            { name: 'Type',            doc: 'The OLE DB data type, e.g. 200 = adVarChar, 3 = adInteger, 135 = adDBTimeStamp.' },
            { name: 'DefinedSize',     doc: 'The declared width of the column.' },
            { name: 'ActualSize',      doc: 'The length of the value actually held.' },
            { name: 'NumericScale',    doc: 'Digits to the right of the decimal point, for a numeric column.' },
            { name: 'Precision',       doc: 'Total digits, for a numeric column.' },
            { name: 'Attributes',      doc: 'Bit flags describing the column — nullable, updatable, long.' },
            { name: 'OriginalValue',   doc: 'The value the field had before any pending edit.' },
            { name: 'UnderlyingValue', doc: 'The value currently in the database, re-read from the provider.' },
            { name: 'GetChunk',        doc: 'Reads part of a long binary or text column.',                 snippet: 'GetChunk($0)' },
            { name: 'AppendChunk',     doc: 'Appends to a long binary or text column.',                    snippet: 'AppendChunk $0' },
        ],
    },

    'adodb.parameter': {
        label: 'ADODB.Parameter',
        members: [
            { name: 'Value',        doc: 'The value passed for this parameter.' },
            { name: 'Name',         doc: 'The parameter name, conventionally `"@id"`.' },
            { name: 'Type',         doc: 'The OLE DB data type of the parameter.' },
            { name: 'Direction',    doc: '1 = Input, 2 = Output, 3 = InputOutput, 4 = ReturnValue.' },
            { name: 'Size',         doc: 'Maximum length, required for variable-length types.' },
            { name: 'Precision',    doc: 'Total digits, for a numeric parameter.' },
            { name: 'NumericScale', doc: 'Digits to the right of the decimal point.' },
            { name: 'Attributes',   doc: 'Bit flags — whether the parameter accepts Null, signed values, or long data.' },
            { name: 'AppendChunk',  doc: 'Appends to a long binary or text parameter.',                    snippet: 'AppendChunk $0' },
        ],
    },

    // The way a page handles bytes: reading an upload, writing a file without
    // the FileSystemObject, or converting between a byte array and text.
    'adodb.stream': {
        label: 'ADODB.Stream',
        members: [
            { name: 'Open',         doc: 'Opens the stream. Called with no arguments for a stream held in memory.', snippet: 'Open' },
            { name: 'Close',        doc: 'Closes the stream.' },
            { name: 'Read',         doc: 'Reads a number of bytes, or all of them with `-1` (adReadAll).', snippet: 'Read($0)' },
            { name: 'ReadText',     doc: 'Reads characters, or all of them with `-1`. Needs Type = 2 (adTypeText).', snippet: 'ReadText($0)' },
            { name: 'Write',        doc: 'Writes a byte array to the stream.',                             snippet: 'Write $0' },
            { name: 'WriteText',    doc: 'Writes a string to the stream. Needs Type = 2 (adTypeText).',    snippet: 'WriteText $0' },
            { name: 'SaveToFile',   doc: 'Writes the stream to a file. Mode 1 = create only, 2 = overwrite.', snippet: 'SaveToFile "$1", $2' },
            { name: 'LoadFromFile', doc: 'Fills the stream from a file.',                                  snippet: 'LoadFromFile "$0"' },
            { name: 'CopyTo',       doc: 'Copies this stream into another.',                               snippet: 'CopyTo $0' },
            { name: 'Flush',        doc: 'Writes anything buffered out to the underlying object.' },
            { name: 'SetEOS',       doc: 'Makes the current Position the end of the stream, truncating the rest.' },
            { name: 'Cancel',       doc: 'Cancels an asynchronous operation still in progress.' },
            { name: 'Type',         doc: '1 = adTypeBinary, 2 = adTypeText. Can only be changed at Position 0.' },
            { name: 'Charset',      doc: 'The encoding used to translate text, e.g. `"utf-8"`, `"windows-1252"`.' },
            { name: 'Position',     doc: 'The current byte offset within the stream.' },
            { name: 'Size',         doc: 'Read-only. The total length of the stream in bytes.' },
            { name: 'EOS',          doc: 'Read-only. `True` when Position has reached the end of the stream.' },
            { name: 'State',        doc: '0 = Closed, 1 = Open.' },
            { name: 'LineSeparator', doc: 'The value ReadText treats as a line break — 13 = adCR, 10 = adLF, -1 = adCRLF.' },
            { name: 'Mode',         doc: 'Read/write permissions for the stream.' },
        ],
    },

    'adodb.error': {
        label: 'ADODB.Error',
        members: [
            { name: 'Number',      doc: 'The error code.' },
            { name: 'Description', doc: 'A short description of the error.' },
            { name: 'Source',      doc: 'The object or provider that raised the error.' },
            { name: 'SQLState',    doc: 'The five-character ANSI SQL state code, when the provider supplies one.' },
            { name: 'NativeError', doc: 'The provider-specific error code — the SQL Server error number, for instance.' },
            { name: 'HelpFile',    doc: 'Path of the help file associated with the error.' },
            { name: 'HelpContext', doc: 'Context id of the help topic associated with the error.' },
        ],
    },

    'scripting.dictionary': {
        label: 'Scripting.Dictionary',
        members: [
            { name: 'Add',         doc: 'Adds a key/value pair. Errors if the key already exists.',       snippet: 'Add "$1", $2' },
            { name: 'Remove',      doc: 'Removes the entry for a given key.',                             snippet: 'Remove "$0"' },
            { name: 'RemoveAll',   doc: 'Removes all key/value pairs from the dictionary.' },
            { name: 'Exists',      doc: 'Returns `True` if the specified key exists.',                    snippet: 'Exists("$0")' },
            { name: 'Item',        doc: 'Gets or sets the value associated with a key. Reading a key that does not exist ADDS it with an empty value.', snippet: 'Item("$0")' },
            { name: 'Key',         doc: 'Write-only. Renames an existing key: `d.Key("old") = "new"`.',   snippet: 'Key("$0")' },
            { name: 'Items',       doc: 'Returns an array of all values.' },
            { name: 'Keys',        doc: 'Returns an array of all keys.' },
            { name: 'Count',       doc: 'Number of key/value pairs currently in the dictionary.' },
            { name: 'CompareMode', doc: '0 = Binary (case-sensitive), 1 = Text (case-insensitive). Can only be set while the dictionary is empty.' },
        ],
    },

    'scripting.filesystemobject': {
        label: 'Scripting.FileSystemObject',
        members: [
            { name: 'CreateTextFile',        doc: 'Creates a new text file and returns a TextStream object.',        snippet: 'CreateTextFile("$1", $2)' },
            { name: 'OpenTextFile',          doc: 'Opens a file and returns a TextStream. Mode: 1=Read, 2=Write, 8=Append.', snippet: 'OpenTextFile("$1", $2)' },
            { name: 'FileExists',            doc: 'Returns `True` if the specified file exists.',                    snippet: 'FileExists("$0")' },
            { name: 'FolderExists',          doc: 'Returns `True` if the specified folder exists.',                  snippet: 'FolderExists("$0")' },
            { name: 'DriveExists',           doc: 'Returns `True` if the specified drive exists.',                   snippet: 'DriveExists("$0")' },
            { name: 'DeleteFile',            doc: 'Deletes the specified file.',                                     snippet: 'DeleteFile("$0")' },
            { name: 'DeleteFolder',          doc: 'Deletes the specified folder and its contents.',                  snippet: 'DeleteFolder("$0")' },
            { name: 'CreateFolder',          doc: 'Creates a folder and returns it. Errors if it already exists.',   snippet: 'CreateFolder("$0")' },
            { name: 'CopyFile',              doc: 'Copies a file from source to destination.',                       snippet: 'CopyFile "$1", "$2"' },
            { name: 'MoveFile',              doc: 'Moves a file from source to destination.',                        snippet: 'MoveFile "$1", "$2"' },
            { name: 'CopyFolder',            doc: 'Copies a folder and everything inside it.',                       snippet: 'CopyFolder "$1", "$2"' },
            { name: 'MoveFolder',            doc: 'Moves a folder and everything inside it.',                        snippet: 'MoveFolder "$1", "$2"' },
            { name: 'GetFile',               doc: 'Returns a File object for the given path.',                       snippet: 'GetFile("$0")' },
            { name: 'GetFolder',             doc: 'Returns a Folder object for the given path.',                     snippet: 'GetFolder("$0")' },
            { name: 'GetDrive',              doc: 'Returns a Drive object for the given drive letter or share.',     snippet: 'GetDrive("$0")' },
            { name: 'Drives',                doc: 'Collection of every Drive available to the server.' },
            { name: 'GetFileName',           doc: 'Returns just the filename portion of a full path.',               snippet: 'GetFileName("$0")' },
            { name: 'GetBaseName',           doc: 'Returns the filename without its extension.',                     snippet: 'GetBaseName("$0")' },
            { name: 'GetExtensionName',      doc: 'Returns the extension of a path, without the dot.',               snippet: 'GetExtensionName("$0")' },
            { name: 'GetDriveName',          doc: 'Returns the drive portion of a path.',                            snippet: 'GetDriveName("$0")' },
            { name: 'GetParentFolderName',   doc: 'Returns the parent folder path.',                                 snippet: 'GetParentFolderName("$0")' },
            { name: 'GetAbsolutePathName',   doc: 'Resolves a relative path against the current directory. NOT the same as Server.MapPath, which resolves a virtual path.', snippet: 'GetAbsolutePathName("$0")' },
            { name: 'GetSpecialFolder',      doc: 'Returns a Folder for 0 = Windows, 1 = System, 2 = Temp.',         snippet: 'GetSpecialFolder($0)' },
            { name: 'GetTempName',           doc: 'Returns a randomly generated name for a temporary file. Does not create it.' },
            { name: 'BuildPath',             doc: 'Appends a name to an existing path.',                             snippet: 'BuildPath("$1", "$2")' },
        ],
    },

    // Returned by FileSystemObject.OpenTextFile / CreateTextFile, and by
    // File.OpenAsTextStream.
    'scripting.textstream': {
        label: 'Scripting.TextStream',
        members: [
            { name: 'Read',             doc: 'Reads a given number of characters.',                       snippet: 'Read($0)' },
            { name: 'ReadLine',         doc: 'Reads one line, without its newline.' },
            { name: 'ReadAll',          doc: 'Reads the whole file into one string.' },
            { name: 'Write',            doc: 'Writes a string with no trailing newline.',                 snippet: 'Write $0' },
            { name: 'WriteLine',        doc: 'Writes a string followed by a newline.',                     snippet: 'WriteLine $0' },
            { name: 'WriteBlankLines',  doc: 'Writes a number of empty lines.',                            snippet: 'WriteBlankLines $0' },
            { name: 'Skip',             doc: 'Skips a number of characters when reading.',                 snippet: 'Skip $0' },
            { name: 'SkipLine',         doc: 'Skips the next line when reading.' },
            { name: 'Close',            doc: 'Closes the stream and releases the file.' },
            { name: 'AtEndOfStream',    doc: 'Read-only. `True` once the end of the file is reached — the usual `Do Until` test.' },
            { name: 'AtEndOfLine',      doc: 'Read-only. `True` when the pointer sits just before a line break.' },
            { name: 'Line',             doc: 'Read-only. The current line number, counting from 1.' },
            { name: 'Column',           doc: 'Read-only. The current column number, counting from 1.' },
        ],
    },

    'scripting.file': {
        label: 'Scripting.File',
        members: [
            { name: 'Name',              doc: 'The file name, without its folder.' },
            { name: 'Path',              doc: 'The full path to the file.' },
            { name: 'ShortName',         doc: 'The 8.3 form of the name.' },
            { name: 'ShortPath',         doc: 'The 8.3 form of the full path.' },
            { name: 'Size',              doc: 'The size of the file in bytes.' },
            { name: 'Type',              doc: 'The description the shell gives the file type, e.g. "Text Document".' },
            { name: 'DateCreated',       doc: 'When the file was created.' },
            { name: 'DateLastModified',  doc: 'When the file was last written to.' },
            { name: 'DateLastAccessed',  doc: 'When the file was last read.' },
            { name: 'Attributes',        doc: 'Bit flags — 1 = ReadOnly, 2 = Hidden, 4 = System, 32 = Archive.' },
            { name: 'ParentFolder',      doc: 'The Folder that contains this file.' },
            { name: 'Drive',             doc: 'The Drive the file is on.' },
            { name: 'Copy',              doc: 'Copies the file to another path.',                          snippet: 'Copy "$0"' },
            { name: 'Move',              doc: 'Moves the file to another path.',                           snippet: 'Move "$0"' },
            { name: 'Delete',            doc: 'Deletes the file.' },
            { name: 'OpenAsTextStream',  doc: 'Opens the file and returns a TextStream. Mode: 1=Read, 2=Write, 8=Append.', snippet: 'OpenAsTextStream($0)' },
        ],
    },

    'scripting.folder': {
        label: 'Scripting.Folder',
        members: [
            { name: 'Name',             doc: 'The folder name, without its parent path.' },
            { name: 'Path',             doc: 'The full path to the folder.' },
            { name: 'ShortName',        doc: 'The 8.3 form of the name.' },
            { name: 'ShortPath',        doc: 'The 8.3 form of the full path.' },
            { name: 'Size',             doc: 'The total size of everything in the folder, in bytes.' },
            { name: 'Type',             doc: 'The description the shell gives the folder type.' },
            { name: 'Files',            doc: 'Collection of the File objects directly inside this folder.' },
            { name: 'SubFolders',       doc: 'Collection of the Folder objects directly inside this folder.' },
            { name: 'ParentFolder',     doc: 'The Folder that contains this one.' },
            { name: 'Drive',            doc: 'The Drive the folder is on.' },
            { name: 'IsRootFolder',     doc: '`True` when this is the root of its drive.' },
            { name: 'Attributes',       doc: 'Bit flags — 2 = Hidden, 4 = System, 16 = Directory.' },
            { name: 'DateCreated',      doc: 'When the folder was created.' },
            { name: 'DateLastModified', doc: 'When the folder was last written to.' },
            { name: 'DateLastAccessed', doc: 'When the folder was last read.' },
            { name: 'Copy',             doc: 'Copies the folder to another path.',                         snippet: 'Copy "$0"' },
            { name: 'Move',             doc: 'Moves the folder to another path.',                          snippet: 'Move "$0"' },
            { name: 'Delete',           doc: 'Deletes the folder and everything in it.' },
            { name: 'CreateTextFile',   doc: 'Creates a text file in this folder and returns a TextStream.', snippet: 'CreateTextFile("$1", $2)' },
        ],
    },

    'scripting.drive': {
        label: 'Scripting.Drive',
        members: [
            { name: 'DriveLetter',     doc: 'The drive letter, without a colon.' },
            { name: 'DriveType',       doc: '0 = Unknown, 1 = Removable, 2 = Fixed, 3 = Network, 4 = CD-ROM, 5 = RAM disk.' },
            { name: 'Path',            doc: 'The drive path, e.g. `"C:"`.' },
            { name: 'RootFolder',      doc: 'The Folder at the root of the drive.' },
            { name: 'AvailableSpace',  doc: 'Bytes available to the current user — may be less than FreeSpace under a quota.' },
            { name: 'FreeSpace',       doc: 'Bytes free on the drive.' },
            { name: 'TotalSize',       doc: 'Total bytes on the drive.' },
            { name: 'FileSystem',      doc: 'The file system in use, e.g. `"NTFS"`.' },
            { name: 'IsReady',         doc: '`True` when the drive has media in it and can be read.' },
            { name: 'SerialNumber',    doc: 'The volume serial number.' },
            { name: 'ShareName',       doc: 'The network share name, for a mapped drive.' },
            { name: 'VolumeName',      doc: 'The volume label. Can be written to.' },
        ],
    },

    'msxml2.domdocument': {
        label: 'MSXML2.DOMDocument',
        members: [
            { name: 'Load',                doc: 'Loads XML from a file or URL.',                          snippet: 'Load("$0")' },
            { name: 'LoadXML',             doc: 'Loads XML from a string.',                               snippet: 'LoadXML($0)' },
            { name: 'Save',                doc: 'Saves the XML document.',                                snippet: 'Save("$0")' },
            { name: 'SelectNodes',         doc: 'Selects nodes matching an XPath.',                       snippet: 'SelectNodes("$0")' },
            { name: 'SelectSingleNode',    doc: 'Selects a single node by XPath.',                        snippet: 'SelectSingleNode("$0")' },
            { name: 'CreateElement',       doc: 'Creates a new element node.',                            snippet: 'CreateElement("$0")' },
            { name: 'CreateTextNode',      doc: 'Creates a new text node.',                               snippet: 'CreateTextNode($0)' },
            { name: 'CreateAttribute',     doc: 'Creates a new attribute node.',                          snippet: 'CreateAttribute("$0")' },
            { name: 'CreateCDATASection',  doc: 'Creates a new CDATA section.',                           snippet: 'CreateCDATASection($0)' },
            { name: 'CreateNode',          doc: 'Creates a node of any type. Args: type, name, namespace URI.', snippet: 'CreateNode($1, "$2", "$3")' },
            { name: 'AppendChild',         doc: 'Appends a node as the last child.',                      snippet: 'AppendChild $0' },
            { name: 'TransformNode',       doc: 'Applies an XSLT stylesheet and returns the result as a string.', snippet: 'TransformNode($0)' },
            { name: 'SetProperty',         doc: 'Sets a parser property — `SetProperty "SelectionLanguage", "XPath"` is the common one.', snippet: 'SetProperty "$1", "$2"' },
            { name: 'Async',               doc: 'Set to `False` before Load, or the page carries on before the document has arrived.' },
            { name: 'ValidateOnParse',     doc: 'Whether the parser validates against a DTD or schema while loading.' },
            { name: 'ResolveExternals',    doc: 'Whether external definitions are fetched while loading.' },
            { name: 'PreserveWhiteSpace',  doc: 'Whether whitespace between elements is kept.' },
            { name: 'DocumentElement',     doc: 'The root element of the document.' },
            { name: 'ChildNodes',          doc: 'The child nodes of the document.' },
            { name: 'ReadyState',          doc: '4 = loaded and parsed. Only meaningful when Async is True.' },
            { name: 'XML',                 doc: 'String representation of the document XML.' },
            { name: 'Text',                doc: 'The text content, with all markup stripped.' },
            { name: 'ParseError',          doc: 'Error object from the last load. Check `.errorCode` before using the document.' },
        ],
    },

    'msxml2.ixmldomnode': {
        label: 'MSXML2 DOM node',
        members: [
            { name: 'SelectNodes',       doc: 'Selects descendant nodes matching an XPath.',              snippet: 'SelectNodes("$0")' },
            { name: 'SelectSingleNode',  doc: 'Selects a single descendant by XPath.',                    snippet: 'SelectSingleNode("$0")' },
            { name: 'AppendChild',       doc: 'Appends a node as the last child.',                        snippet: 'AppendChild $0' },
            { name: 'RemoveChild',       doc: 'Removes a child node.',                                    snippet: 'RemoveChild $0' },
            { name: 'ReplaceChild',      doc: 'Replaces one child node with another.',                    snippet: 'ReplaceChild $1, $2' },
            { name: 'InsertBefore',      doc: 'Inserts a node before an existing child.',                 snippet: 'InsertBefore $1, $2' },
            { name: 'CloneNode',         doc: 'Copies the node. Pass `True` to copy its subtree too.',     snippet: 'CloneNode($0)' },
            { name: 'GetAttribute',      doc: 'Returns an attribute value by name.',                      snippet: 'GetAttribute("$0")' },
            { name: 'SetAttribute',      doc: 'Sets an attribute value by name.',                         snippet: 'SetAttribute "$1", $2' },
            { name: 'TransformNode',     doc: 'Applies an XSLT stylesheet to this node.',                 snippet: 'TransformNode($0)' },
            { name: 'NodeName',          doc: 'The element or attribute name.' },
            { name: 'NodeValue',         doc: 'The value, for a text or attribute node.' },
            { name: 'NodeType',          doc: '1 = element, 2 = attribute, 3 = text, 4 = CDATA, 8 = comment, 9 = document.' },
            { name: 'Text',              doc: 'The text content of the node and its descendants.' },
            { name: 'XML',               doc: 'The node and its subtree, serialised back to XML.' },
            { name: 'Attributes',        doc: 'The attributes of this node.' },
            { name: 'ChildNodes',        doc: 'The child nodes of this node.' },
            { name: 'FirstChild',        doc: 'The first child node, or Nothing.' },
            { name: 'LastChild',         doc: 'The last child node, or Nothing.' },
            { name: 'NextSibling',       doc: 'The next node at this level, or Nothing.' },
            { name: 'PreviousSibling',   doc: 'The previous node at this level, or Nothing.' },
            { name: 'ParentNode',        doc: 'The node that contains this one.' },
            { name: 'HasChildNodes',     doc: '`True` when the node has at least one child.' },
            { name: 'OwnerDocument',     doc: 'The document this node belongs to.' },
            { name: 'BaseName',          doc: 'The name without its namespace prefix.' },
            { name: 'NamespaceURI',      doc: 'The namespace URI of the node.' },
        ],
    },

    'msxml2.ixmldomnodelist': {
        label: 'MSXML2 DOM node list',
        members: [
            { name: 'Item',     doc: 'The node at a zero-based index.',                                   snippet: 'Item($0)' },
            { name: 'Length',   doc: 'How many nodes the list holds.' },
            { name: 'NextNode', doc: 'Returns the next node and advances the internal cursor.' },
            { name: 'Reset',    doc: 'Moves the internal cursor back before the first node.' },
        ],
    },

    'msxml2.serverxmlhttp': {
        label: 'MSXML2.ServerXMLHTTP',
        members: [
            { name: 'Open',                   doc: 'Initialises the request. Args: method, url, async.',   snippet: 'Open "$1", "$2", False' },
            { name: 'Send',                   doc: 'Sends the HTTP request.',                              snippet: 'Send($0)' },
            { name: 'Abort',                  doc: 'Cancels a request that is still in progress.' },
            { name: 'SetRequestHeader',       doc: 'Sets an HTTP request header.',                         snippet: 'SetRequestHeader "$1", "$2"' },
            { name: 'GetResponseHeader',      doc: 'Gets a response header.',                              snippet: 'GetResponseHeader("$0")' },
            { name: 'GetAllResponseHeaders',  doc: 'Returns every response header as one string.' },
            { name: 'SetTimeouts',            doc: 'Milliseconds for resolve, connect, send and receive. ServerXMLHTTP has no timeout by default.', snippet: 'SetTimeouts $1, $2, $3, $4' },
            { name: 'SetOption',              doc: 'Sets a request option — option 2 controls certificate error handling.', snippet: 'SetOption $1, $2' },
            { name: 'WaitForResponse',        doc: 'Blocks until an asynchronous response arrives, or the timeout passes.', snippet: 'WaitForResponse($0)' },
            { name: 'ResponseText',           doc: 'Response body as a string.' },
            { name: 'ResponseXML',            doc: 'Response body as an XML document.' },
            { name: 'ResponseBody',           doc: 'Response body as a byte array — what to use for anything not text.' },
            { name: 'ResponseStream',         doc: 'Response body as an IStream.' },
            { name: 'ReadyState',             doc: '4 = complete. Only meaningful for an asynchronous request.' },
            { name: 'Status',                 doc: 'HTTP status code (e.g. 200).' },
            { name: 'StatusText',             doc: 'HTTP status text (e.g. "OK").' },
        ],
    },

    // The mail object on any IIS from 5.0 onward. Configuration is the part that
    // catches people out: without it CDO tries to deliver locally.
    'cdo.message': {
        label: 'CDO.Message',
        members: [
            { name: 'Send',            doc: 'Sends the message.' },
            { name: 'To',              doc: 'Recipients, separated by semicolons.' },
            { name: 'From',            doc: 'The sender address.' },
            { name: 'Cc',              doc: 'Carbon-copy recipients, separated by semicolons.' },
            { name: 'Bcc',             doc: 'Blind carbon-copy recipients, separated by semicolons.' },
            { name: 'ReplyTo',         doc: 'The address replies should go to, when it differs from From.' },
            { name: 'Subject',         doc: 'The subject line.' },
            { name: 'TextBody',        doc: 'The plain-text body.' },
            { name: 'HTMLBody',        doc: 'The HTML body. Setting both this and TextBody sends a multipart message.' },
            { name: 'AddAttachment',   doc: 'Attaches a file by physical path — use Server.MapPath for one in the site.', snippet: 'AddAttachment "$0"' },
            { name: 'CreateMHTMLBody', doc: 'Fetches a URL and builds the body from it, images included.', snippet: 'CreateMHTMLBody "$0"' },
            { name: 'Configuration',   doc: 'The Configuration object whose Fields hold the SMTP settings.' },
            { name: 'Fields',          doc: 'The message header fields, keyed by schema URL.',            snippet: 'Fields("$0")' },
            { name: 'Attachments',     doc: 'The attachments added so far.' },
            { name: 'BodyPart',        doc: 'The root MIME body part of the message.' },
            { name: 'Sender',          doc: 'The address in the Sender header.' },
            { name: 'Organization',    doc: 'The Organization header.' },
            { name: 'MimeFormatted',   doc: 'Whether the message is MIME-formatted.' },
            { name: 'GetStream',       doc: 'Returns the whole message as a stream.' },
        ],
    },

    'cdo.configuration': {
        label: 'CDO.Configuration',
        members: [
            { name: 'Fields', doc: 'The settings, keyed by schema URL — `.Item("http://schemas.microsoft.com/cdo/configuration/smtpserver")`.', snippet: 'Fields.Item("$0")' },
            { name: 'Load',   doc: 'Loads settings from a source, e.g. the IIS metabase.',                snippet: 'Load $0' },
        ],
    },

    // Superseded by CDO.Message, and absent from Windows Server 2003 onward,
    // but still the mail object in a great deal of older code.
    'cdonts.newmail': {
        label: 'CDONTS.NewMail',
        members: [
            { name: 'Send',            doc: 'Sends the message. The object cannot be reused afterwards.', snippet: 'Send' },
            { name: 'To',              doc: 'Recipients, separated by semicolons.' },
            { name: 'From',            doc: 'The sender address.' },
            { name: 'Cc',              doc: 'Carbon-copy recipients.' },
            { name: 'Bcc',             doc: 'Blind carbon-copy recipients.' },
            { name: 'Subject',         doc: 'The subject line.' },
            { name: 'Body',            doc: 'The message body. Its format is set by BodyFormat.' },
            { name: 'BodyFormat',      doc: '0 = HTML, 1 = plain text.' },
            { name: 'MailFormat',      doc: '0 = MIME, 1 = plain text.' },
            { name: 'Importance',      doc: '0 = low, 1 = normal, 2 = high.' },
            { name: 'AttachFile',      doc: 'Attaches a file by physical path.',                          snippet: 'AttachFile "$0"' },
            { name: 'AttachURL',       doc: 'Attaches the content at a URL.',                             snippet: 'AttachURL "$1", "$2"' },
            { name: 'Value',           doc: 'Sets an additional message header.',                         snippet: 'Value("$1") = "$2"' },
            { name: 'ContentBase',     doc: 'The base URL for relative links in an HTML body.' },
            { name: 'ContentLocation', doc: 'The location of the body content.' },
        ],
    },

    'wscript.shell': {
        label: 'WScript.Shell',
        members: [
            { name: 'Run',                          doc: 'Runs a program. Args: command, window style, wait for it to finish.', snippet: 'Run "$1", $2, $3' },
            { name: 'Exec',                         doc: 'Executes a command and returns a process object whose output can be read.', snippet: 'Exec("$0")' },
            { name: 'ExpandEnvironmentStrings',     doc: 'Expands environment variable strings.',                    snippet: 'ExpandEnvironmentStrings("$0")' },
            { name: 'RegRead',                      doc: 'Reads a value from the registry.',                         snippet: 'RegRead("$0")' },
            { name: 'RegWrite',                     doc: 'Writes a value to the registry.',                          snippet: 'RegWrite "$1", $2' },
            { name: 'RegDelete',                    doc: 'Deletes a key from the registry.',                         snippet: 'RegDelete("$0")' },
            { name: 'Environment',                  doc: 'Environment variables collection.',                        snippet: 'Environment("$0")' },
            { name: 'CurrentDirectory',             doc: 'Gets or sets the process working directory.' },
            { name: 'SpecialFolders',               doc: 'Paths of the shell special folders, by name.',             snippet: 'SpecialFolders("$0")' },
            { name: 'CreateShortcut',               doc: 'Creates or opens a shortcut file.',                        snippet: 'CreateShortcut("$0")' },
            { name: 'AppActivate',                  doc: 'Brings a window to the foreground. Meaningless on a server with no desktop.', snippet: 'AppActivate "$0"' },
            { name: 'SendKeys',                     doc: 'Sends keystrokes to the active window. Meaningless on a server with no desktop.', snippet: 'SendKeys "$0"' },
            { name: 'Popup',                        doc: 'Shows a message box. It has no desktop to appear on in ASP, so it blocks until its timeout.', snippet: 'Popup "$0"' },
            { name: 'LogEvent',                     doc: 'Writes an entry to the Windows event log.',                snippet: 'LogEvent $1, "$2"' },
        ],
    },

};

// ─────────────────────────────────────────────────────────────────────────────
// ProgID normalisation
//
// `Server.CreateObject("MSXML2.DOMDocument.6.0")` is the recommended spelling,
// not the exception, and the raw string was being used as the lookup key — so
// every version-pinned page got the empty-member-list treatment. The same goes
// for the older aliases nobody has rewritten: Microsoft.XMLHTTP, ADODB.Field.1,
// and the free-threaded DOM document.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ProgIDs that name the same thing as a key in COM_RAW under a different name.
 *
 * Resolution is a single lookup, so a value here must be a COM_RAW key and
 * never another alias. The version suffix is already gone by the time this is
 * consulted, so there is nothing to add for `ADODB.Connection.1` and friends.
 *
 * XMLHTTP is the one approximation: it is a different object from
 * ServerXMLHTTP — WinInet rather than WinHTTP — but the member surface is the
 * same apart from SetTimeouts, SetOption and WaitForResponse, which it does not
 * have. Three members over-offered beats the empty list it got before.
 */
const PROG_ID_ALIASES: Record<string, string> = {
    'microsoft.xmlhttp':                'msxml2.serverxmlhttp',
    'msxml2.xmlhttp':                   'msxml2.serverxmlhttp',
    'microsoft.xmldom':                 'msxml2.domdocument',
    'msxml2.freethreadeddomdocument':   'msxml2.domdocument',
    'msxml.domdocument':                'msxml2.domdocument',
};

/**
 * Turns whatever was written inside CreateObject into a COM_RAW key.
 *
 * The trailing version is stripped before the alias table is consulted, so
 * `MSXML2.DOMDocument.6.0` and `MSXML2.DOMDocument` take the same path. A
 * ProgID's version suffix is always numeric — `Scripting.Dictionary` keeps its
 * second component because `dictionary` is not a number.
 */
export function normalizeProgId(progId: string): string {
    const lower = progId.trim().toLowerCase();
    const unversioned = lower.replace(/(?:\.\d+)+$/, '');
    return PROG_ID_ALIASES[unversioned] ?? unversioned;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// COM_METHOD_RETURN_TYPES
// Maps "progid.methodname" → the progId of the COM object the method returns.
// Used by extractSymbols to infer types from chained calls like:
//   Set rs = oConn.Execute(sql)  →  rs is typed as adodb.recordset
// Only methods that return a typed COM object are listed here.
//
// Every value must be a key of COM_RAW — a type inferred from here and then not
// found is worse than no inference at all, because the completion provider
// answers a dotted access on a KNOWN variable with an empty list. There is a
// unit test holding that line.
// ─────────────────────────────────────────────────────────────────────────────
export const COM_METHOD_RETURN_TYPES: Record<string, string> = {
    // ADODB
    'adodb.connection.execute':                   'adodb.recordset',
    'adodb.connection.openschema':                'adodb.recordset',
    'adodb.command.execute':                      'adodb.recordset',
    'adodb.command.createparameter':              'adodb.parameter',
    'adodb.recordset.nextrecordset':              'adodb.recordset',
    // Indexing a collection, not calling a method — but it is written with
    // parentheses, which is all the chain rule looks for, and it is the only
    // way a page ever gets hold of a Field, an Error or a stored Parameter.
    'adodb.recordset.fields':                     'adodb.field',
    'adodb.connection.errors':                    'adodb.error',
    'adodb.command.parameters':                   'adodb.parameter',

    // Scripting.FileSystemObject
    'scripting.filesystemobject.createtextfile':  'scripting.textstream',
    'scripting.filesystemobject.opentextfile':    'scripting.textstream',
    'scripting.filesystemobject.getfile':         'scripting.file',
    'scripting.filesystemobject.getfolder':       'scripting.folder',
    'scripting.filesystemobject.createfolder':    'scripting.folder',
    'scripting.filesystemobject.getspecialfolder': 'scripting.folder',
    'scripting.filesystemobject.getdrive':        'scripting.drive',
    'scripting.file.openastextstream':            'scripting.textstream',
    'scripting.folder.createtextfile':            'scripting.textstream',

    // MSXML2
    'msxml2.domdocument.selectnodes':             'msxml2.ixmldomnodelist',
    'msxml2.domdocument.selectsinglenode':        'msxml2.ixmldomnode',
    'msxml2.domdocument.createelement':           'msxml2.ixmldomnode',
    'msxml2.domdocument.createtextnode':          'msxml2.ixmldomnode',
    'msxml2.domdocument.createnode':              'msxml2.ixmldomnode',
    'msxml2.ixmldomnode.selectnodes':             'msxml2.ixmldomnodelist',
    'msxml2.ixmldomnode.selectsinglenode':        'msxml2.ixmldomnode',
    'msxml2.ixmldomnode.clonenode':               'msxml2.ixmldomnode',
    'msxml2.ixmldomnodelist.item':                'msxml2.ixmldomnode',
};
