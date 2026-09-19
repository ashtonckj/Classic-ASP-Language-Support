// ─────────────────────────────────────────────────────────────────────────────
// ASP intrinsic objects
//
// The seven objects the ASP runtime puts in scope without anyone creating them.
// This is the complete member set of each, not a sample: the list used to hold
// four or five members per object, so ordinary code like `Response.CharSet` or
// `Server.Transfer` had no completion, no hover, and nothing marking it as part
// of the language.
//
// `kind` separates the three things a member can be, because they are not used
// the same way. A collection is indexed — `Request.Form("name")`; a property is
// read or assigned — `Response.Buffer = True`; a method is called.
//
// Members are the documented ASP 3.0 set (IIS 5.0 onwards). Nothing here is
// version-gated, since every supported IIS provides all of it.
// ─────────────────────────────────────────────────────────────────────────────

export type AspMemberKind = 'method' | 'property' | 'collection';

export interface AspObjectMember {
    name: string;
    kind: AspMemberKind;
    doc: string;
    /** Completion insert text, when the member reads better with its call shape. */
    snippet?: string;
}

export interface AspObjectDef {
    name: string;
    description: string;
    members: AspObjectMember[];
}

export const ASP_OBJECTS: AspObjectDef[] = [
    {
        name: 'Response',
        description: 'Send output to the client',
        members: [
            { name: 'Write',            kind: 'method',     doc: 'Writes a value to the current HTTP response.', snippet: 'Write($0)' },
            { name: 'BinaryWrite',      kind: 'method',     doc: 'Writes raw bytes to the response without character conversion — for images, PDFs and other binary content.', snippet: 'BinaryWrite($0)' },
            { name: 'Redirect',         kind: 'method',     doc: 'Sends a 302 and tells the browser to request a different URL. Anything written before it is discarded.', snippet: 'Redirect("$0")' },
            { name: 'End',              kind: 'method',     doc: 'Stops processing the page and sends what has been buffered so far.' },
            { name: 'Clear',            kind: 'method',     doc: 'Discards the buffered response body. Requires `Response.Buffer = True`.' },
            { name: 'Flush',            kind: 'method',     doc: 'Sends the buffered response so far immediately. Requires `Response.Buffer = True`.' },
            { name: 'AddHeader',        kind: 'method',     doc: 'Adds an HTTP header. Must be called before any body output unless the response is buffered.', snippet: 'AddHeader "$1", "$0"' },
            { name: 'AppendToLog',      kind: 'method',     doc: 'Appends a string to the web server log entry for this request.', snippet: 'AppendToLog "$0"' },
            { name: 'Buffer',           kind: 'property',   doc: 'Whether output is held until the page finishes. `True` by default in ASP 3.0, and required by Clear, Flush and a late Redirect.' },
            { name: 'CacheControl',     kind: 'property',   doc: 'Sets the Cache-Control header — `"Public"` lets proxies cache the page, `"Private"` (the default) does not.' },
            { name: 'Charset',          kind: 'property',   doc: 'Appends a character set to the Content-Type header, e.g. `Response.Charset = "utf-8"`.' },
            { name: 'ContentType',      kind: 'property',   doc: 'The HTTP content type, e.g. `"text/html"`, `"application/json"`, `"text/xml"`.' },
            { name: 'Expires',          kind: 'property',   doc: 'Minutes before a cached page expires. `0` forces revalidation on every request.' },
            { name: 'ExpiresAbsolute',  kind: 'property',   doc: 'The date and time at which a cached page expires.' },
            { name: 'IsClientConnected', kind: 'property',  doc: 'Read-only. `False` once the client has disconnected — worth checking inside a long loop.' },
            { name: 'PICS',             kind: 'property',   doc: 'Adds a PICS content-rating label to the response headers.' },
            { name: 'Status',           kind: 'property',   doc: 'The HTTP status line, e.g. `"404 Not Found"` or `"301 Moved Permanently"`.' },
            { name: 'Cookies',          kind: 'collection', doc: 'The cookies sent to the browser. Write-only: `Response.Cookies("name") = value`.', snippet: 'Cookies("$0")' },
        ],
    },
    {
        name: 'Request',
        description: 'Get information from the user',
        members: [
            { name: 'Form',              kind: 'collection', doc: 'Values posted from a form body (`method="post"`).', snippet: 'Form("$0")' },
            { name: 'QueryString',       kind: 'collection', doc: 'Values from the URL query string after the `?`.', snippet: 'QueryString("$0")' },
            { name: 'Cookies',           kind: 'collection', doc: 'Cookies sent by the browser. Read-only on Request; write through Response.Cookies.', snippet: 'Cookies("$0")' },
            { name: 'ServerVariables',   kind: 'collection', doc: 'HTTP headers and server environment values, e.g. `"REMOTE_ADDR"`, `"HTTP_USER_AGENT"`, `"SCRIPT_NAME"`.', snippet: 'ServerVariables("$0")' },
            { name: 'ClientCertificate', kind: 'collection', doc: 'Fields of the client TLS certificate, when one was presented.', snippet: 'ClientCertificate("$0")' },
            { name: 'TotalBytes',        kind: 'property',   doc: 'Read-only. The number of bytes in the request body, for use with BinaryRead.' },
            { name: 'BinaryRead',        kind: 'method',     doc: 'Reads the raw request body as a byte array — how file uploads are read without a component.', snippet: 'BinaryRead($0)' },
        ],
    },
    {
        name: 'Server',
        description: 'Server utilities and methods',
        members: [
            { name: 'CreateObject',  kind: 'method',   doc: 'Creates an instance of a registered COM component by ProgID.', snippet: 'CreateObject("$0")' },
            { name: 'MapPath',       kind: 'method',   doc: 'Turns a virtual path into the physical path on disk.', snippet: 'MapPath("$0")' },
            { name: 'HTMLEncode',    kind: 'method',   doc: 'Escapes `& < > "` so a value is safe to write into markup.', snippet: 'HTMLEncode($0)' },
            { name: 'URLEncode',     kind: 'method',   doc: 'Escapes a value for use in a URL query string.', snippet: 'URLEncode($0)' },
            { name: 'Execute',       kind: 'method',   doc: 'Runs another .asp file as if it were part of this one, then returns.', snippet: 'Execute("$0")' },
            { name: 'Transfer',      kind: 'method',   doc: 'Hands the request to another .asp file, keeping the current state, and does not return.', snippet: 'Transfer("$0")' },
            { name: 'GetLastError',  kind: 'method',   doc: 'Returns an ASPError object describing the error that ended the previous page. Used in a custom error page.' },
            { name: 'ScriptTimeout', kind: 'property', doc: 'Seconds a page may run before the server stops it.' },
        ],
    },
    {
        name: 'Session',
        description: 'Store per-user state across requests',
        members: [
            { name: 'Contents',      kind: 'collection', doc: 'Values stored in the session. `Session.Contents.Remove("key")` and `.RemoveAll()` clear them.', snippet: 'Contents("$0")' },
            { name: 'StaticObjects',  kind: 'collection', doc: 'Read-only. Objects added to the session with `<object runat="server" scope="session">`.' },
            { name: 'Abandon',       kind: 'method',     doc: 'Destroys the session and its contents at the end of this request.' },
            { name: 'SessionID',     kind: 'property',   doc: 'Read-only. The identifier for this session. Not unique across application restarts, so do not use it as a database key.' },
            { name: 'Timeout',       kind: 'property',   doc: 'Minutes of inactivity before the session is abandoned.' },
            { name: 'CodePage',      kind: 'property',   doc: 'The code page used to convert strings for output.' },
            { name: 'LCID',          kind: 'property',   doc: 'The locale identifier, which decides date, time and currency formatting.' },
        ],
    },
    {
        name: 'Application',
        description: 'Share information among all users',
        members: [
            { name: 'Contents',      kind: 'collection', doc: 'Values shared by every session. `Application.Contents.Remove("key")` and `.RemoveAll()` clear them.', snippet: 'Contents("$0")' },
            { name: 'StaticObjects', kind: 'collection', doc: 'Read-only. Objects added with `<object runat="server" scope="application">`.' },
            { name: 'Lock',          kind: 'method',     doc: 'Blocks other sessions from changing Application state — always pair with Unlock.' },
            { name: 'Unlock',        kind: 'method',     doc: 'Releases the lock taken by Lock.' },
        ],
    },
    {
        name: 'ASPError',
        description: 'Details of the error that ended the previous page',
        members: [
            { name: 'ASPCode',        kind: 'property', doc: 'Read-only. The error code generated by IIS.' },
            { name: 'ASPDescription', kind: 'property', doc: 'Read-only. A longer description, for errors that are ASP-specific.' },
            { name: 'Category',       kind: 'property', doc: 'Read-only. Whether the error came from ASP itself, the scripting language, or a component.' },
            { name: 'Column',         kind: 'property', doc: 'Read-only. The column in the file where the error occurred.' },
            { name: 'Description',    kind: 'property', doc: 'Read-only. A short description of the error.' },
            { name: 'File',           kind: 'property', doc: 'Read-only. The .asp file being processed when the error occurred.' },
            { name: 'Line',           kind: 'property', doc: 'Read-only. The line in the file where the error occurred.' },
            { name: 'Number',         kind: 'property', doc: 'Read-only. The standard COM error code.' },
            { name: 'Source',         kind: 'property', doc: 'Read-only. The source line that raised the error.' },
        ],
    },
    {
        name: 'ObjectContext',
        description: 'Control the transaction a page takes part in',
        members: [
            { name: 'SetComplete', kind: 'method', doc: 'Votes to commit the transaction this page is part of.' },
            { name: 'SetAbort',    kind: 'method', doc: 'Votes to abort the transaction this page is part of.' },
        ],
    },
];

/** Lowercased names of the intrinsic objects, for quick membership tests. */
export const ASP_OBJECT_NAMES: ReadonlySet<string> = new Set(
    ASP_OBJECTS.map(object => object.name.toLowerCase()),
);

/**
 * Every intrinsic member keyed as `object.member`, both lowercased, so hover can
 * look one up from the text around the caret without walking the list.
 */
export const ASP_MEMBER_DOCS: Record<string, { label: string; kind: AspMemberKind; doc: string }> = {};
for (const object of ASP_OBJECTS) {
    for (const member of object.members) {
        ASP_MEMBER_DOCS[`${object.name.toLowerCase()}.${member.name.toLowerCase()}`] = {
            label: `${object.name}.${member.name}`,
            kind:  member.kind,
            doc:   member.doc,
        };
    }
}

// VBScript Keywords
export const VBSCRIPT_KEYWORDS = [
    { keyword: 'Dim', description: 'Declare variables' },
    { keyword: 'ReDim', description: 'Redimension dynamic array' },
    { keyword: 'Const', description: 'Declare constants' },
    { keyword: 'If', description: 'Conditional statement' },
    { keyword: 'Then', description: 'Part of If statement' },
    { keyword: 'Else', description: 'Alternative condition' },
    { keyword: 'ElseIf', description: 'Additional condition' },
    { keyword: 'End If', description: 'End If statement' },
    { keyword: 'Select Case', description: 'Multiple condition statement' },
    { keyword: 'Case', description: 'Case in Select statement' },
    { keyword: 'End Select', description: 'End Select statement' },
    { keyword: 'For', description: 'For loop' },
    { keyword: 'To', description: 'For loop range' },
    { keyword: 'Step', description: 'For loop increment' },
    { keyword: 'Next', description: 'End For loop' },
    { keyword: 'For Each', description: 'Iterate collection' },
    { keyword: 'In', description: 'Part of For Each' },
    { keyword: 'While', description: 'While loop' },
    { keyword: 'Wend', description: 'End While loop' },
    { keyword: 'Do', description: 'Do loop' },
    { keyword: 'Loop', description: 'End Do loop' },
    { keyword: 'Until', description: 'Loop condition' },
    { keyword: 'Exit', description: 'Exit loop or function' },
    { keyword: 'Sub', description: 'Declare subroutine' },
    { keyword: 'End Sub', description: 'End subroutine' },
    { keyword: 'Function', description: 'Declare function' },
    { keyword: 'End Function', description: 'End function' },
    { keyword: 'Call', description: 'Call subroutine' },
    { keyword: 'Class', description: 'Declare class' },
    { keyword: 'End Class', description: 'End class' },
    { keyword: 'Property', description: 'Declare property' },
    { keyword: 'End Property', description: 'End property' },
    { keyword: 'Get', description: 'Property getter' },
    { keyword: 'Let', description: 'Property setter' },
    { keyword: 'Set', description: 'Set object reference' },
    { keyword: 'New', description: 'Create new object' },
    { keyword: 'With', description: 'With statement' },
    { keyword: 'End With', description: 'End With statement' },
    { keyword: 'Private', description: 'Private scope' },
    { keyword: 'Public', description: 'Public scope' },
    { keyword: 'Option Explicit', description: 'Require variable declaration' },
    { keyword: 'On Error Resume Next', description: 'Error handling' },
    { keyword: 'And', description: 'Logical AND' },
    { keyword: 'Or', description: 'Logical OR' },
    { keyword: 'Not', description: 'Logical NOT' },
    { keyword: 'Xor', description: 'Logical XOR' },
    { keyword: 'True', description: 'Boolean true' },
    { keyword: 'False', description: 'Boolean false' },
    { keyword: 'Null', description: 'Null value' },
    { keyword: 'Nothing', description: 'Empty object reference' },
    { keyword: 'Empty', description: 'Empty variant' },
];

// Common VBScript Functions
export const VBSCRIPT_FUNCTIONS = [
    'Abs', 'Array', 'Asc', 'Atn', 'CBool', 'CByte', 'CCur', 'CDate', 'CDbl', 'Chr',
    'CInt', 'CLng', 'Cos', 'CreateObject', 'CSng', 'CStr', 'Date', 'DateAdd',
    'DateDiff', 'DatePart', 'DateSerial', 'DateValue', 'Day', 'Exp', 'Filter',
    'Fix', 'FormatCurrency', 'FormatDateTime', 'FormatNumber', 'FormatPercent',
    'GetObject', 'Hex', 'Hour', 'InputBox', 'InStr', 'InStrRev', 'Int', 'IsArray',
    'IsDate', 'IsEmpty', 'IsNull', 'IsNumeric', 'IsObject', 'Join', 'LBound',
    'LCase', 'Left', 'Len', 'LoadPicture', 'Log', 'LTrim', 'Mid', 'Minute',
    'Month', 'MonthName', 'MsgBox', 'Now', 'Oct', 'Replace', 'RGB', 'Right',
    'Rnd', 'Round', 'RTrim', 'Second', 'Sgn', 'Sin', 'Space', 'Split', 'Sqr',
    'StrComp', 'String', 'StrReverse', 'Tan', 'Time', 'Timer', 'TimeSerial',
    'TimeValue', 'Trim', 'TypeName', 'UBound', 'UCase', 'VarType', 'Weekday',
    'WeekdayName', 'Year'
];

// ─────────────────────────────────────────────────────────────────────────────
// VBSCRIPT_KEYWORDS_SET
// Flat lowercase Set used by aspSemanticProvider to skip colouring keywords
// as user variables/functions. Derives from VBSCRIPT_KEYWORDS above so the
// two never drift apart, then adds extra bare tokens that appear in VBScript
// code but are not in the completion keyword list (mid-word tokens, operators,
// built-in object names, etc.).
// ─────────────────────────────────────────────────────────────────────────────
export const VBSCRIPT_KEYWORDS_SET = new Set([
    // All keywords from the completion list above (lowercased)
    ...VBSCRIPT_KEYWORDS.map(kw => kw.keyword.toLowerCase()),
    // Extra bare tokens not in the completion list
    'end', 'each', 'in', 'to', 'step', 'until', 'then', 'wend', 'loop',
    'eqv', 'imp', 'is', 'mod', 'xor',
    'exit', 'return', 'goto', 'on', 'error', 'resume',
    'randomize',
    // Built-in ASP object names — should never be treated as user symbols
    'response', 'request', 'server', 'session', 'application',
]);