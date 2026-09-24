// ─────────────────────────────────────────────────────────────────────────────
// ASP intrinsic objects
//
// The objects that are in scope on every page without anyone creating them:
// the seven from the ASP runtime, plus VBScript's `Err`. Err belongs to the
// language rather than to ASP, but it reaches the editor the same way — a name
// nobody declared, carrying members — and `On Error Resume Next` followed by
// `If Err.Number <> 0 Then` is how a Classic ASP page handles an error at all.
//
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
    {
        name: 'Err',
        description: 'The last runtime error (VBScript, not ASP)',
        members: [
            { name: 'Number',      kind: 'property', doc: 'The error code. `0` means no error — this is what `On Error Resume Next` code tests. Assigning to it also raises the error.' },
            { name: 'Description', kind: 'property', doc: 'A short description of the error.' },
            { name: 'Source',      kind: 'property', doc: 'The name of the object or application that raised the error.' },
            { name: 'HelpFile',    kind: 'property', doc: 'Path of the help file associated with the error.' },
            { name: 'HelpContext', kind: 'property', doc: 'Context id of the help topic associated with the error.' },
            { name: 'Clear',       kind: 'method',   doc: 'Resets Err to `0`/empty. `On Error Resume Next` does NOT clear it between statements, so a later check sees the earlier error unless this is called.' },
            { name: 'Raise',       kind: 'method',   doc: 'Raises a runtime error. Custom codes are conventionally `vbObjectError + n`.', snippet: 'Raise $1, "$2", "$0"' },
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
    { keyword: 'Preserve', description: 'Keep existing data when redimensioning' },
    { keyword: 'Erase', description: 'Clear an array' },
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
    { keyword: 'Exit Do', description: 'Leave a Do loop' },
    { keyword: 'Exit For', description: 'Leave a For loop' },
    { keyword: 'Exit Sub', description: 'Leave a subroutine' },
    { keyword: 'Exit Function', description: 'Leave a function' },
    { keyword: 'Exit Property', description: 'Leave a property' },
    { keyword: 'Sub', description: 'Declare subroutine' },
    { keyword: 'End Sub', description: 'End subroutine' },
    { keyword: 'Function', description: 'Declare function' },
    { keyword: 'End Function', description: 'End function' },
    { keyword: 'ByRef', description: 'Pass a parameter by reference (the default)' },
    { keyword: 'ByVal', description: 'Pass a parameter by value' },
    { keyword: 'Call', description: 'Call subroutine' },
    { keyword: 'Class', description: 'Declare class' },
    { keyword: 'End Class', description: 'End class' },
    { keyword: 'Property', description: 'Declare property' },
    { keyword: 'End Property', description: 'End property' },
    { keyword: 'Get', description: 'Property getter' },
    { keyword: 'Let', description: 'Property setter' },
    { keyword: 'Set', description: 'Set object reference' },
    { keyword: 'New', description: 'Create new object' },
    { keyword: 'Me', description: 'The current instance, inside a class' },
    { keyword: 'Default', description: "A class's default member — `Public Default Function`" },
    { keyword: 'Class_Initialize', description: 'Runs when an instance of the class is created' },
    { keyword: 'Class_Terminate', description: 'Runs when an instance of the class is released' },
    { keyword: 'With', description: 'With statement' },
    { keyword: 'End With', description: 'End With statement' },
    { keyword: 'Private', description: 'Private scope' },
    { keyword: 'Public', description: 'Public scope' },
    { keyword: 'Option Explicit', description: 'Require variable declaration' },
    { keyword: 'On Error Resume Next', description: 'Carry on at the statement after an error, leaving it in Err' },
    { keyword: 'On Error GoTo 0', description: 'Stop ignoring errors — the counterpart of On Error Resume Next' },
    { keyword: 'Rem', description: 'Comment, the older spelling of an apostrophe' },
    { keyword: 'Stop', description: 'Break into the debugger' },
    { keyword: 'Randomize', description: 'Seed the random number generator used by Rnd' },
    { keyword: 'And', description: 'Logical AND' },
    { keyword: 'Or', description: 'Logical OR' },
    { keyword: 'Not', description: 'Logical NOT' },
    { keyword: 'Xor', description: 'Logical XOR' },
    { keyword: 'Eqv', description: 'Logical equivalence' },
    { keyword: 'Imp', description: 'Logical implication' },
    { keyword: 'Is', description: 'Compare two object references' },
    { keyword: 'Mod', description: 'Remainder after division' },
    { keyword: 'True', description: 'Boolean true' },
    { keyword: 'False', description: 'Boolean false' },
    { keyword: 'Null', description: 'Null value' },
    { keyword: 'Nothing', description: 'Empty object reference' },
    { keyword: 'Empty', description: 'Empty variant' },
];

// ─────────────────────────────────────────────────────────────────────────────
// VBScript's built-in functions — the whole documented set for VBScript 5.x,
// which is what every supported IIS ships.
//
// A few are here despite being useless on a server, because they are part of
// the language and a page that calls one should still be told what it is:
// MsgBox and InputBox block on a dialog nobody can see, and LoadPicture needs a
// display. The syntaxes/ grammar colours the same set, so the two are meant to
// be compared when either changes.
//
// The `B` variants (AscB, ChrB, InStrB, LeftB, LenB, MidB, RightB) work in
// bytes rather than characters. They are rare but real, and turn up in older
// code that handles binary uploads a byte at a time.
// ─────────────────────────────────────────────────────────────────────────────
export const VBSCRIPT_FUNCTIONS = [
    'Abs', 'Array', 'Asc', 'AscB', 'AscW', 'Atn', 'CBool', 'CByte', 'CCur',
    'CDate', 'CDbl', 'Chr', 'ChrB', 'ChrW', 'CInt', 'CLng', 'Cos',
    'CreateObject', 'CSng', 'CStr', 'Date', 'DateAdd', 'DateDiff', 'DatePart',
    'DateSerial', 'DateValue', 'Day', 'Escape', 'Eval', 'Execute',
    'ExecuteGlobal', 'Exp', 'Filter', 'Fix', 'FormatCurrency',
    'FormatDateTime', 'FormatNumber', 'FormatPercent', 'GetLocale', 'GetObject',
    'GetRef', 'Hex', 'Hour', 'InputBox', 'InStr', 'InStrB', 'InStrRev', 'Int',
    'IsArray', 'IsDate', 'IsEmpty', 'IsNull', 'IsNumeric', 'IsObject', 'Join',
    'LBound', 'LCase', 'Left', 'LeftB', 'Len', 'LenB', 'LoadPicture', 'Log',
    'LTrim', 'Mid', 'MidB', 'Minute', 'Month', 'MonthName', 'MsgBox', 'Now',
    'Oct', 'Replace', 'RGB', 'Right', 'RightB', 'Rnd', 'Round', 'RTrim',
    'ScriptEngine', 'ScriptEngineBuildVersion', 'ScriptEngineMajorVersion',
    'ScriptEngineMinorVersion', 'Second', 'SetLocale', 'Sgn', 'Sin', 'Space',
    'Split', 'Sqr', 'StrComp', 'String', 'StrReverse', 'Tan', 'Time', 'Timer',
    'TimeSerial', 'TimeValue', 'Trim', 'TypeName', 'UBound', 'UCase',
    'Unescape', 'VarType', 'Weekday', 'WeekdayName', 'Year'
];

// ─────────────────────────────────────────────────────────────────────────────
// Built-in VBScript function docs — hover, completion and signature help
// ─────────────────────────────────────────────────────────────────────────────
export const BUILTIN_FUNCTION_DOCS: Record<string, string> = {
    'abs':             '**Abs(number)** — Returns the absolute value of a number.',
    'array':           '**Array(arglist)** — Returns a Variant containing an array.\n\n`arglist` — Comma-delimited list of values. If omitted, an empty array is created.',
    'asc':             '**Asc(string)** — Returns the ANSI character code of the first character in a string.',
    'ascb':            '**AscB(string)** — Returns the first byte of a string, as a number. For byte data such as `Request.BinaryRead` results; `Asc` is almost always the one to use on text.',
    'ascw':            '**AscW(string)** — Returns the Unicode character code of the first character in a string. Unlike `Asc`, the result does not depend on the code page the server uses.',
    'atn':             '**Atn(number)** — Returns the arctangent of a number (in radians).',
    'cbool':           '**CBool(expression)** — Converts an expression to a Boolean.',
    'cbyte':           '**CByte(expression)** — Converts an expression to a Byte.',
    'ccur':            '**CCur(expression)** — Converts an expression to Currency.',
    'cdate':           '**CDate(expression)** — Converts an expression to a Date.',
    'cdbl':            '**CDbl(expression)** — Converts an expression to a Double.',
    'chr':             '**Chr(charcode)** — Returns the character associated with an ANSI character code.',
    'chrb':            '**ChrB(charcode)** — Returns a one-byte string for the byte value `charcode` (`0`–`255`). For building byte data; `Chr` is the one to use for text.',
    'chrw':            '**ChrW(charcode)** — Returns the character for a Unicode character code, e.g. `ChrW(8364)` → `€`. Unlike `Chr`, it does not depend on the code page the server uses.',
    'cint':            '**CInt(expression)** — Converts an expression to an Integer.',
    'clng':            '**CLng(expression)** — Converts an expression to a Long.',
    'cos':             '**Cos(number)** — Returns the cosine of an angle (in radians).',
    'createobject':    '**CreateObject(servername.typename)** — Creates and returns a reference to an Automation object.',
    'csng':            '**CSng(expression)** — Converts an expression to a Single.',
    'cstr':            '**CStr(expression)** — Converts an expression to a String.',
    'date':            '**Date()** — Returns the current system date.',
    'dateadd':         '**DateAdd(interval, number, date)** — Returns a date with a specified time interval added.\n\n---\n\n| Parameter | Description |\n|---|---|\n| `interval` | `"yyyy"` year · `"q"` quarter · `"m"` month · `"y"` day of year · `"d"` day · `"w"` weekday · `"ww"` week · `"h"` hour · `"n"` minute · `"s"` second |\n| `number` | Intervals to add. Positive = future, negative = past |\n| `date` | The starting date |',
    'datediff':        '**DateDiff(interval, date1, date2[, firstdayofweek[, firstweekofyear]])** — Returns the number of intervals between two dates.\n\n---\n\n| Parameter | Description |\n|---|---|\n| `interval` | Same values as `DateAdd` |\n| `date1` | The earlier date |\n| `date2` | The later date |\n| `firstdayofweek` | `1` → Sun (default) · `2` → Mon · `3` → Tue · `4` → Wed · `5` → Thu · `6` → Fri · `7` → Sat |\n| `firstweekofyear` | `1` → week with Jan 1 (default) · `2` → first week with 4+ days · `3` → first full week |',
    'datepart':        '**DatePart(interval, date[, firstdayofweek[, firstweekofyear]])** — Returns the specified part of a given date.\n\n---\n\n| Parameter | Description |\n|---|---|\n| `interval` | Same values as `DateAdd` |\n| `date` | The date to evaluate |\n| `firstdayofweek` | `1` → Sun (default) · `2` → Mon · `3` → Tue · `4` → Wed · `5` → Thu · `6` → Fri · `7` → Sat |\n| `firstweekofyear` | `1` → week with Jan 1 (default) · `2` → first week with 4+ days · `3` → first full week |',
    'dateserial':      '**DateSerial(year, month, day)** — Returns a Date variant for the specified year, month, and day.\n\n---\n\n| Parameter | Description |\n|---|---|\n| `year` | Four-digit year. Values 0–99 are treated as 1900–1999 |\n| `month` | `1`–`12`. Values outside this range roll over (e.g. `13` = Jan next year) |\n| `day` | `1`–`31`. Values outside this range roll over (e.g. `32` = 1st of next month) |',
    'datevalue':       '**DateValue(date)** — Returns a Variant of subtype Date.',
    'day':             '**Day(date)** — Returns a whole number (1–31) representing the day of the month.',
    'escape':          '**Escape(charString)** — Returns the string with every character outside plain ASCII letters, digits and `@*_+-./` encoded as `%xx`, or `%uxxxx` above 255.\n\nNot the same as `Server.URLEncode`: a space becomes `%20`, not `+`. Decode with `Unescape`.',
    'eval':            '**Eval(expression)** — Evaluates a string as a VBScript expression and returns the result.\n\nInside `Eval`, `=` compares rather than assigns: `Eval("x = 1")` returns `True` or `False`. To run statements, use `Execute`.\n\n**Security:** never pass it text that came from the request.',
    'execute':         '**Execute(statement)** — Runs one or more VBScript statements given as a string, separated by `:` or line breaks, in the current scope.\n\n**Security:** never pass it text that came from the request.',
    'executeglobal':   '**ExecuteGlobal(statement)** — Runs one or more VBScript statements given as a string in the global scope, so a `Function`, `Sub`, `Class` or variable it declares is visible to the whole page.\n\n**Security:** never pass it text that came from the request.',
    'exp':             '**Exp(number)** — Returns e raised to a power.',
    'filter':          '**Filter(InputStrings, Value[, Include[, Compare]])** — Returns a zero-based array of matched strings from an array.\n\n---\n\n| Parameter | Description |\n|---|---|\n| `InputStrings` | One-dimensional string array to search |\n| `Value` | The string to search for |\n| `Include` | `True` → return matches · `False` → return non-matches |\n| `Compare` | `0` → case-sensitive · `1` → case-insensitive |',
    'fix':             '**Fix(number)** — Returns the integer portion of a number (truncates toward zero).',
    'formatcurrency':  '**FormatCurrency(Expression[, NumDigitsAfterDecimal[, IncludeLeadingDigit[, UseParensForNegativeNumbers[, GroupDigits]]]])** — Returns a value formatted as currency using the system currency symbol.\n\n---\n\n| Parameter | Values |\n|---|---|\n| `NumDigitsAfterDecimal` | `-1` → system default |\n| `IncludeLeadingDigit` | `-1` → `$0.50` · `0` → `$.50` · `-2` → system default |\n| `UseParensForNegativeNumbers` | `-1` → `($1.00)` · `0` → `-$1.00` · `-2` → system default |\n| `GroupDigits` | `-1` → `$1,000.00` · `0` → `$1000.00` · `-2` → system default |',
    'formatdatetime':  '**FormatDateTime(Date[, NamedFormat])** — Returns an expression formatted as a date or time.\n\n---\n\n| NamedFormat | Output |\n|---|---|\n| `0` → vbGeneralDate (default) | Date and/or time |\n| `1` → vbLongDate | e.g. `Monday, 1 January 2024` |\n| `2` → vbShortDate | e.g. `01/01/2024` |\n| `3` → vbLongTime | e.g. `12:00:00 AM` |\n| `4` → vbShortTime | e.g. `12:00` |',
    'formatnumber':    '**FormatNumber(Expression[, NumDigitsAfterDecimal[, IncludeLeadingDigit[, UseParensForNegativeNumbers[, GroupDigits]]]])** — Returns an expression formatted as a number.\n\n---\n\n| Parameter | Values |\n|---|---|\n| `NumDigitsAfterDecimal` | `-1` → system default |\n| `IncludeLeadingDigit` | `-1` → `0.5` · `0` → `.5` · `-2` → system default |\n| `UseParensForNegativeNumbers` | `-1` → `(1.00)` · `0` → `-1.00` · `-2` → system default |\n| `GroupDigits` | `-1` → `1,000.00` · `0` → `1000.00` · `-2` → system default |',
    'formatpercent':   '**FormatPercent(Expression[, NumDigitsAfterDecimal[, IncludeLeadingDigit[, UseParensForNegativeNumbers[, GroupDigits]]]])** — Returns an expression formatted as a percentage (multiplied by 100).\n\n---\n\n| Parameter | Values |\n|---|---|\n| `NumDigitsAfterDecimal` | `-1` → system default |\n| `IncludeLeadingDigit` | `-1` → `0.50%` · `0` → `.50%` · `-2` → system default |\n| `UseParensForNegativeNumbers` | `-1` → `(50.00%)` · `0` → `-50.00%` · `-2` → system default |\n| `GroupDigits` | `-1` → `1,000.00%` · `0` → `1000.00%` · `-2` → system default |',
    'getlocale':       '**GetLocale()** — Returns the current locale ID (LCID), which decides how dates, numbers and currency are formatted and parsed, e.g. `1033` for en-US. See `SetLocale`, or `Session.LCID` for the ASP way.',
    'getobject':       '**GetObject([pathname[, class]])** — Returns a reference to an Automation object.\n\n`pathname` — Full path of the file. Omit to use `class` alone.\n\n`class` — Object class e.g. `"Excel.Sheet"`. Required if `pathname` is omitted.',
    'getref':          '**GetRef(procname)** — Returns a reference to the `Function` or `Sub` named by the string `procname`, to call later or hand on as a callback: `Set f = GetRef("Report") : f("x")`.',
    'hex':             '**Hex(number)** — Returns a string representing the hexadecimal value of a number.',
    'hour':            '**Hour(time)** — Returns a whole number (0–23) representing the hour of the day.',
    'inputbox':        '**InputBox(prompt[, title[, default[, xpos[, ypos]]]])** — Displays a prompt dialog and returns the text entered.\n\n---\n\n| Parameter | Description |\n|---|---|\n| `prompt` | Message shown to the user |\n| `title` | Title bar text (defaults to app name) |\n| `default` | Pre-filled value. Empty if omitted |\n| `xpos` | Horizontal position in twips from screen left |\n| `ypos` | Vertical position in twips from screen top |',
    'instr':           '**InStr([start, ]string1, string2[, compare])** — Returns the position of the first occurrence of `string2` in `string1`, or `0` if not found.\n\n`start` — Search start position (default `1`). Required if `compare` is specified.\n\n`compare` — `0` → case-sensitive · `1` → case-insensitive',
    'instrb':          '**InStrB([start, ]string1, string2[, compare])** — Like `InStr`, but returns the BYTE position of `string2` in `string1` — for byte data. `start` is a byte position too.',
    'instrrev':        '**InStrRev(string1, string2[, start[, compare]])** — Returns the position of the last occurrence of `string2` in `string1`, or `0` if not found.\n\n`start` — Start position counting from left. `-1` (default) = from last character.\n\n`compare` — `0` → case-sensitive · `1` → case-insensitive',
    'int':             '**Int(number)** — Returns the integer portion of a number (rounds down).',
    'isarray':         '**IsArray(varname)** — Returns True if the variable is an array.',
    'isdate':          '**IsDate(expression)** — Returns True if the expression can be converted to a date.',
    'isempty':         '**IsEmpty(expression)** — Returns True if the variable is uninitialized.',
    'isnull':          '**IsNull(expression)** — Returns True if the expression is Null.',
    'isnumeric':       '**IsNumeric(expression)** — Returns True if the expression can be evaluated as a number.',
    'isobject':        '**IsObject(expression)** — Returns True if the expression references a valid object.',
    'join':            '**Join(list[, delimiter])** — Returns a string by joining elements of an array.\n\n`delimiter` — Separator between elements. Default is a single space. Use `""` for no separator.',
    'lbound':          '**LBound(arrayname[, dimension])** — Returns the smallest subscript for the given array dimension.\n\n`dimension` — `1` (default) = first dimension, `2` = second, etc.',
    'lcase':           '**LCase(string)** — Returns a string converted to lowercase.',
    'left':            '**Left(string, length)** — Returns a specified number of characters from the left of a string.',
    'leftb':           '**LeftB(string, length)** — Like `Left`, but `length` counts bytes, not characters — for byte data.',
    'len':             '**Len(string | varname)** — Returns the number of characters in a string, or bytes needed to store a variable.',
    'lenb':            '**LenB(string)** — Returns the number of bytes in a string, rather than characters. A VBScript string is UTF-16, so this is usually twice `Len`.',
    'loadpicture':     '**LoadPicture(picturename)** — Returns a picture object loaded from a file.\n\nOnly works in client-side VBScript; it is not available to an ASP page running on the server.',
    'log':             '**Log(number)** — Returns the natural logarithm of a number.',
    'ltrim':           '**LTrim(string)** — Returns a copy of a string without leading spaces.',
    'mid':             '**Mid(string, start[, length])** — Returns characters from within a string.\n\n`start` — Position of the first character to return (`1` = first).\n\n`length` — Number of characters to return. If omitted, returns from `start` to end.',
    'midb':            '**MidB(string, start[, length])** — Like `Mid`, but `start` and `length` count bytes, not characters — for byte data.',
    'minute':          '**Minute(time)** — Returns a whole number (0–59) representing the minute of the hour.',
    'month':           '**Month(date)** — Returns a whole number (1–12) representing the month of the year.',
    'monthname':       '**MonthName(month[, abbreviate])** — Returns the name of the specified month.\n\n`abbreviate` — `True` → e.g. `"Jan"` · `False` (default) → e.g. `"January"`',
    'msgbox':          '**MsgBox(prompt[, buttons[, title]])** — Displays a message dialog and returns the clicked button.\n\n---\n\n| Parameter | Description |\n|---|---|\n| `prompt` | Message shown to the user |\n| `buttons` | `0` → OK · `1` → OK+Cancel · `2` → Abort/Retry/Ignore · `3` → Yes/No/Cancel · `4` → Yes/No · `5` → Retry/Cancel. Add `16` critical · `32` question · `48` warning · `64` info |\n| `title` | Title bar text (defaults to app name) |\n\n**Returns:** `1` → OK · `2` → Cancel · `3` → Abort · `4` → Retry · `5` → Ignore · `6` → Yes · `7` → No',
    'now':             '**Now()** — Returns the current system date and time.',
    'oct':             '**Oct(number)** — Returns a string representing the octal value of a number.',
    'replace':         '**Replace(expression, find, replacewith[, start[, count[, compare]]])** — Returns a string with occurrences of a substring replaced.\n\n---\n\n| Parameter | Description |\n|---|---|\n| `expression` | The source string |\n| `find` | Substring to search for |\n| `replacewith` | Substring to replace with |\n| `start` | Position to begin searching (default `1`). Note: result string always starts at this position |\n| `count` | Max replacements. `-1` (default) = replace all |\n| `compare` | `0` → case-sensitive · `1` → case-insensitive |',
    'rgb':             '**RGB(red, green, blue)** — Returns a whole number representing an RGB colour value.',
    'right':           '**Right(string, length)** — Returns a specified number of characters from the right of a string.',
    'rightb':          '**RightB(string, length)** — Like `Right`, but `length` counts bytes, not characters — for byte data.',
    'rnd':             '**Rnd([number])** — Returns a random Single between 0 and 1. Call `Randomize` first for a different sequence each run.\n\n`number` — `< 0` → same number for same seed · `> 0` or omitted → next in sequence · `= 0` → most recently generated number',
    'round':           '**Round(expression[, numdecimalplaces])** — Returns a number rounded to a specified number of decimal places. Uses banker\'s rounding (rounds to even) on `.5`.\n\n`numdecimalplaces` — Decimal places to keep. `0` (default) = round to whole number.',
    'rtrim':           '**RTrim(string)** — Returns a copy of a string without trailing spaces.',
    'scriptengine':    '**ScriptEngine()** — Returns the name of the scripting language in use: `"VBScript"`.',
    'scriptenginebuildversion':'**ScriptEngineBuildVersion()** — Returns the build number of the VBScript engine in use.',
    'scriptenginemajorversion':'**ScriptEngineMajorVersion()** — Returns the major version of the VBScript engine in use, e.g. `5`.',
    'scriptengineminorversion':'**ScriptEngineMinorVersion()** — Returns the minor version of the VBScript engine in use, e.g. `8`.',
    'second':          '**Second(time)** — Returns a whole number (0–59) representing the second of the minute.',
    'setlocale':       '**SetLocale(lcid)** — Sets the locale that decides how dates, numbers and currency are formatted and parsed, and returns the one it replaced.\n\n`lcid` — A locale ID such as `2057` (en-GB) or `1033` (en-US), or a tag like `"en-gb"`.\n\nIn ASP, `Session.LCID` does the same for the whole session.',
    'sgn':             '**Sgn(number)** — Returns an integer indicating the sign of a number.',
    'sin':             '**Sin(number)** — Returns the sine of an angle (in radians).',
    'space':           '**Space(number)** — Returns a string of the specified number of spaces.',
    'split':           '**Split(expression[, delimiter[, count[, compare]]])** — Returns a zero-based array of substrings split from a string.\n\n`delimiter` — Split separator. Default is a single space.\n\n`count` — Max substrings to return. `-1` (default) = all.\n\n`compare` — `0` → case-sensitive · `1` → case-insensitive',
    'sqr':             '**Sqr(number)** — Returns the square root of a number.',
    'strcomp':         '**StrComp(string1, string2[, compare])** — Returns a value indicating the result of a string comparison.\n\n`compare` — `0` → case-sensitive · `1` → case-insensitive\n\n**Returns:** `-1` → string1 < string2 · `0` → equal · `1` → string1 > string2 · `Null` → either string is Null',
    'string':          '**String(number, character)** — Returns a character repeated a specified number of times.\n\n`character` — A character code (e.g. `42`) or string — only the first character is used.',
    'strreverse':      '**StrReverse(string)** — Returns the reverse of a string.',
    'tan':             '**Tan(number)** — Returns the tangent of an angle (in radians).',
    'time':            '**Time()** — Returns the current system time.',
    'timer':           '**Timer()** — Returns the number of seconds elapsed since midnight.',
    'timeserial':      '**TimeSerial(hour, minute, second)** — Returns a Date variant for the specified time.\n\n`hour` · `minute` · `second` — Values outside their normal range roll over (e.g. hour `24` = midnight next day).',
    'timevalue':       '**TimeValue(time)** — Returns a Variant of subtype Date containing the time.',
    'trim':            '**Trim(string)** — Returns a copy of a string without leading or trailing spaces.',
    'typename':        '**TypeName(varname)** — Returns a string describing the subtype of a variable.',
    'ubound':          '**UBound(arrayname[, dimension])** — Returns the largest subscript for the given array dimension.\n\n`dimension` — `1` (default) = first dimension, `2` = second, etc.',
    'ucase':           '**UCase(string)** — Returns a string converted to uppercase.',
    'unescape':        '**Unescape(charString)** — Decodes a string encoded with `Escape`, turning `%xx` and `%uxxxx` back into characters.',
    'vartype':         '**VarType(varname)** — Returns a value indicating the subtype of a variable.',
    'weekday':         '**Weekday(date[, firstdayofweek])** — Returns a whole number representing the day of the week.\n\n`firstdayofweek` — `1` → Sun (default) · `2` → Mon · `3` → Tue · `4` → Wed · `5` → Thu · `6` → Fri · `7` → Sat\n\n**Returns:** `1`–`7` depending on the `firstdayofweek` setting.',
    'weekdayname':     '**WeekdayName(weekday[, abbreviate[, firstdayofweek]])** — Returns the name of the specified day of the week.\n\n`abbreviate` — `True` → e.g. `"Mon"` · `False` (default) → e.g. `"Monday"`\n\n`firstdayofweek` — `1` → Sun (default) · `2` → Mon · through `7` → Sat',
    'year':            '**Year(date)** — Returns a whole number representing the year.',
};

export interface BuiltinSignature {
    /** `Mid(string, start[, length])` */
    label: string;
    /** Each parameter's name, where it sits in `label`, and its line of the doc if it has one. */
    parameters: { name: string; range: [number, number]; doc?: string }[];
    /** The doc after its bold heading. */
    documentation: string;
}

/**
 * A built-in function's signature, read from the bold heading its doc opens
 * with — `**Mid(string, start[, length])** — …` — so each function is written
 * up once, for hover, completion and parameter hints alike.
 */
export function builtinSignature(doc: string): BuiltinSignature | undefined {
    const heading = /^\*\*([A-Za-z]\w*)\(([^)]*)\)\*\*\s*(?:—\s*)?/.exec(doc);
    if (!heading) { return undefined; }

    const label = `${heading[1]}(${heading[2]})`;
    const documentation = doc.slice(heading[0].length);
    const parameters: BuiltinSignature['parameters'] = [];

    let searchFrom = heading[1].length + 1;
    for (const piece of heading[2].split(',')) {
        // `[start, ]string1` and `string2[, compare]` — the brackets only mark
        // what is optional.
        const name = piece.replace(/[[\]]/g, '').trim();
        if (!name) { continue; }
        const start = label.indexOf(name, searchFrom);
        searchFrom  = start + name.length;

        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const described = new RegExp('\\| `' + escaped + '` \\| ([^|\\n]+) \\|').exec(documentation)
            ?? new RegExp('(?:^|\\n)`' + escaped + '` — ([^\\n]+)').exec(documentation);
        parameters.push({ name, range: [start, start + name.length], doc: described?.[1].trim() });
    }

    return { label, parameters, documentation };
}

// ─────────────────────────────────────────────────────────────────────────────
// VBScript's built-in constants.
//
// The grammar already colours these; this list is what makes them completable.
// The MsgBox and colour families are deliberately absent — neither a dialog nor
// a colour means anything in a page rendered on a server.
// ─────────────────────────────────────────────────────────────────────────────
export const VBSCRIPT_CONSTANTS: { name: string; doc: string }[] = [
    { name: 'vbCrLf',               doc: 'Carriage return + line feed — `Chr(13) & Chr(10)`.' },
    { name: 'vbCr',                 doc: 'Carriage return — `Chr(13)`.' },
    { name: 'vbLf',                 doc: 'Line feed — `Chr(10)`.' },
    { name: 'vbNewLine',            doc: 'The platform newline. On Windows this is the same as vbCrLf.' },
    { name: 'vbTab',                doc: 'Tab — `Chr(9)`.' },
    { name: 'vbNullChar',           doc: 'A character with the value 0 — `Chr(0)`.' },
    { name: 'vbNullString',         doc: 'A null string reference. Not the same as `""`, though it compares equal.' },
    { name: 'vbFormFeed',           doc: 'Form feed — `Chr(12)`.' },
    { name: 'vbVerticalTab',        doc: 'Vertical tab — `Chr(11)`.' },
    { name: 'vbObjectError',        doc: 'The base for user-defined error codes: `Err.Raise vbObjectError + 1`.' },
    { name: 'vbBinaryCompare',      doc: '`0` — case-sensitive comparison, the default for InStr, Replace and StrComp.' },
    { name: 'vbTextCompare',        doc: '`1` — case-insensitive comparison.' },
    { name: 'vbTrue',               doc: '`-1`. A Tristate value, for the FileSystemObject.' },
    { name: 'vbFalse',              doc: '`0`. A Tristate value, for the FileSystemObject.' },
    { name: 'vbUseDefault',         doc: '`-2` — use the system default. A Tristate value.' },
    { name: 'vbSunday',             doc: '`1`. A day constant, for Weekday and WeekdayName.' },
    { name: 'vbMonday',             doc: '`2`. A day constant.' },
    { name: 'vbTuesday',            doc: '`3`. A day constant.' },
    { name: 'vbWednesday',          doc: '`4`. A day constant.' },
    { name: 'vbThursday',           doc: '`5`. A day constant.' },
    { name: 'vbFriday',             doc: '`6`. A day constant.' },
    { name: 'vbSaturday',           doc: '`7`. A day constant.' },
    { name: 'vbUseSystemDayOfWeek', doc: '`0` — use the first day of the week from the system settings.' },
    { name: 'vbFirstJan1',          doc: '`1` — the week containing January 1st is week one.' },
    { name: 'vbFirstFourDays',      doc: '`2` — the first week with at least four days in the new year is week one.' },
    { name: 'vbFirstFullWeek',      doc: '`3` — the first whole week of the new year is week one.' },
    { name: 'vbGeneralDate',        doc: '`0` — date and time in the locale format. A FormatDateTime constant.' },
    { name: 'vbLongDate',           doc: '`1` — the long date format. A FormatDateTime constant.' },
    { name: 'vbShortDate',          doc: '`2` — the short date format. A FormatDateTime constant.' },
    { name: 'vbLongTime',           doc: '`3` — the long time format. A FormatDateTime constant.' },
    { name: 'vbShortTime',          doc: '`4` — 24-hour hh:mm. A FormatDateTime constant.' },
    { name: 'vbEmpty',              doc: '`0` — uninitialised. A VarType return value.' },
    { name: 'vbNull',               doc: '`1` — contains no valid data. A VarType return value.' },
    { name: 'vbInteger',            doc: '`2`. A VarType return value.' },
    { name: 'vbLong',               doc: '`3`. A VarType return value.' },
    { name: 'vbSingle',             doc: '`4`. A VarType return value.' },
    { name: 'vbDouble',             doc: '`5`. A VarType return value.' },
    { name: 'vbCurrency',           doc: '`6`. A VarType return value.' },
    { name: 'vbDate',               doc: '`7`. A VarType return value.' },
    { name: 'vbString',             doc: '`8`. A VarType return value.' },
    { name: 'vbObject',             doc: '`9`. A VarType return value.' },
    { name: 'vbError',              doc: '`10`. A VarType return value.' },
    { name: 'vbBoolean',            doc: '`11`. A VarType return value.' },
    { name: 'vbVariant',            doc: '`12` — only in an array of variants. A VarType return value.' },
    { name: 'vbDataObject',         doc: '`13`. A VarType return value.' },
    { name: 'vbDecimal',            doc: '`14`. A VarType return value.' },
    { name: 'vbByte',               doc: '`17`. A VarType return value.' },
    { name: 'vbArray',              doc: '`8192` — added to the element type. A VarType return value.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// VBSCRIPT_KEYWORDS_SET
//
// Flat lowercase Set of single tokens. `aspSemanticProvider` consults it to
// avoid colouring a keyword as a user variable or function, and
// `aspRenameProvider` to refuse renaming one — or renaming something TO one.
//
// Both ask about ONE identifier at a time, which is why the multi-word entries
// in VBSCRIPT_KEYWORDS have to be split rather than lowercased whole: `'end if'`
// as a single string is a member nothing can ever match, and it left `select`,
// `option` and `explicit` out of the set entirely.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Words VBScript reserves but does not implement.
 *
 * They are kept out of VBSCRIPT_KEYWORDS because offering `Enum` or `Implements`
 * as a completion would suggest a page could use them, and it cannot. They
 * still matter to the rename provider: `Dim Enum` is a syntax error, so
 * renaming a variable to `Enum` produces a page that will not run, and refusing
 * it is the whole point of checking the set.
 */
const VBSCRIPT_RESERVED_UNIMPLEMENTED = [
    'alias', 'any', 'as', 'boolean', 'byte', 'currency', 'debug', 'decimal',
    'double', 'endif', 'enum', 'event', 'gosub', 'implements', 'integer',
    'like', 'long', 'lset', 'object', 'optional', 'paramarray', 'raiseevent',
    'rset', 'shared', 'single', 'static', 'type', 'typeof', 'variant',
];

export const VBSCRIPT_KEYWORDS_SET = new Set([
    // Every word of every keyword above — 'End If' contributes `end` and `if`.
    ...VBSCRIPT_KEYWORDS.flatMap(kw => kw.keyword.toLowerCase().split(/\s+/)),
    // The intrinsic objects, derived rather than listed, so an object added to
    // ASP_OBJECTS cannot be left out of here.
    ...ASP_OBJECT_NAMES,
    ...VBSCRIPT_RESERVED_UNIMPLEMENTED,
    // Bare tokens that appear in VBScript without heading a keyword entry.
    'each', 'goto', 'on', 'error', 'resume',
]);