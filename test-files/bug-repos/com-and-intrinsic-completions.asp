<%@ Language="VBScript" %>
<%
' ============================================================================
' Completion check sheet — every built-in object the extension knows about.
'
' Press F5, open this file in the Extension Development Host, then put the
' caret after one of the dots below and press Ctrl+Space. The comment on each
' line says what should appear.
'
' Two different mechanisms are being checked:
'
'   * a variable typed DIRECTLY, from the ProgID inside CreateObject;
'   * a variable typed by INFERENCE, from a call on a variable that already has
'     a type — `Set ts = fso.OpenTextFile(...)` makes ts a TextStream. If the
'     line that produces it is edited or deleted, the variable below it loses
'     its type and the list goes empty, which is the expected behaviour rather
'     than a bug.
'
' An empty list is the signal that something is wrong: when the extension knows
' a variable but cannot resolve its type it deliberately offers nothing, rather
' than falling back to keywords. So "no suggestions at all" means the ProgID
' did not resolve.
' ============================================================================

Option Explicit

Dim conn, rs, cmd, prm, fld, errItem, stream
Dim fso, ts, fil, fol, drv
Dim xml, nodes, node, http
Dim dict, shell, mail, mailCfg, oldMail
Dim sql, path

sql  = "SELECT * FROM Customers"
path = Server.MapPath("/data/notes.txt")

' ── ADO ─────────────────────────────────────────────────────────────────────
Set conn = Server.CreateObject("ADODB.Connection")
' conn.        → Open, Close, Execute, BeginTrans, Provider, ConnectionString, Errors, State …

Set rs = conn.Execute(sql)
' rs.          → EOF, BOF, MoveNext, MovePrevious, Fields, GetRows, Filter, Sort, RecordCount …
'                MovePrevious is the ADO spelling. MovePrev is not a member of anything.

Set fld = rs.Fields("CustomerName")
' fld.         → Value, Name, Type, ActualSize, DefinedSize, OriginalValue …

Set errItem = conn.Errors(0)
' errItem.     → Number, Description, Source, SQLState, NativeError …

Set cmd = Server.CreateObject("ADODB.Command")
' cmd.         → Execute, CommandText, CommandType, Parameters, CreateParameter, Prepared …

Set prm = cmd.CreateParameter("@id", 3, 1, 4, 7)
' prm.         → Value, Name, Type, Direction, Size, Precision …

Set stream = Server.CreateObject("ADODB.Stream")
' stream.      → Open, Read, ReadText, Write, WriteText, SaveToFile, LoadFromFile, Charset, EOS …

' ── The Scripting runtime ───────────────────────────────────────────────────
Set fso = Server.CreateObject("Scripting.FileSystemObject")
' fso.         → CreateTextFile, OpenTextFile, FileExists, CreateFolder, GetExtensionName, Drives …

Set ts = fso.OpenTextFile(path, 1)
' ts.          → ReadLine, ReadAll, WriteLine, AtEndOfStream, Close, Line, Column …

Set fil = fso.GetFile(path)
' fil.         → Name, Path, Size, DateLastModified, Attributes, OpenAsTextStream, Copy, Delete …

Set fol = fso.GetFolder(Server.MapPath("/data"))
' fol.         → Files, SubFolders, ParentFolder, IsRootFolder, CreateTextFile, Delete …

Set drv = fso.GetDrive("C")
' drv.         → DriveLetter, DriveType, FreeSpace, TotalSize, FileSystem, IsReady, VolumeName …

Set dict = Server.CreateObject("Scripting.Dictionary")
' dict.        → Add, Remove, RemoveAll, Exists, Item, Key, Items, Keys, Count, CompareMode …

' ── MSXML ───────────────────────────────────────────────────────────────────
' The version-pinned ProgID is the spelling Microsoft documents, and it has to
' resolve to the same type as the bare one.
Set xml = Server.CreateObject("MSXML2.DOMDocument.6.0")
' xml.         → Load, LoadXML, SelectNodes, SelectSingleNode, Async, ParseError, DocumentElement …

Set nodes = xml.SelectNodes("//customer")
' nodes.       → Item, Length, NextNode, Reset

Set node = xml.SelectSingleNode("//customer[1]")
' node.        → NodeName, NodeValue, Text, XML, ChildNodes, Attributes, SelectSingleNode …

Set http = Server.CreateObject("MSXML2.ServerXMLHTTP.6.0")
' http.        → Open, Send, SetRequestHeader, SetTimeouts, ResponseText, ResponseBody, Status …

' ── Mail ────────────────────────────────────────────────────────────────────
Set mail = Server.CreateObject("CDO.Message")
' mail.        → Send, To, From, Subject, TextBody, HTMLBody, AddAttachment, Configuration …

Set mailCfg = Server.CreateObject("CDO.Configuration")
' mailCfg.     → Fields, Load

Set oldMail = Server.CreateObject("CDONTS.NewMail")
' oldMail.     → Send, To, From, Subject, Body, BodyFormat, AttachFile, Importance …

' ── The shell ───────────────────────────────────────────────────────────────
Set shell = Server.CreateObject("WScript.Shell")
' shell.       → Run, Exec, RegRead, RegWrite, Environment, SpecialFolders, LogEvent …

' ── The objects nobody creates ──────────────────────────────────────────────
' Response.    → Write, BinaryWrite, Redirect, End, Clear, Flush, AddHeader, Buffer, Charset,
'                ContentType, Expires, Status, IsClientConnected, Cookies …
' Request.     → Form, QueryString, Cookies, ServerVariables, ClientCertificate, TotalBytes, BinaryRead
' Server.      → CreateObject, MapPath, HTMLEncode, URLEncode, Execute, Transfer, GetLastError, ScriptTimeout
' Session.     → Contents, StaticObjects, Abandon, SessionID, Timeout, CodePage, LCID
' Application. → Contents, StaticObjects, Lock, Unlock
' ASPError.    → ASPCode, ASPDescription, Category, Column, Description, File, Line, Number, Source
' ObjectContext. → SetComplete, SetAbort
' Err.         → Number, Description, Source, HelpFile, HelpContext, Clear, Raise

' ── Colouring, not completion ───────────────────────────────────────────────
' Each keyword below should be coloured as a keyword, not as a plain identifier.

Dim buf()
ReDim Preserve buf(10)          ' Preserve is a keyword
Erase buf                       ' Erase is a keyword

' ByRef and ByVal are keywords both here, inside the parameter list …
Sub Describe(ByRef target, ByVal label)
    ' … and Stop is a keyword
    If IsEmpty(target) Then Stop
    Response.Write Server.HTMLEncode(label) & vbCrLf
End Sub

Class Customer
    Private m_id

    Private Sub Class_Initialize()
        m_id = 0
    End Sub

    Public Property Get Id()
        Id = Me.RawId          ' Me is a keyword, not a variable
    End Property

    Public Property Get RawId()
        RawId = m_id
    End Property
End Class

' Err is an intrinsic object, so Err and ASPError colour the way Response does.
On Error Resume Next
Call Describe(Nothing, "check")
If Err.Number <> 0 Then
    Response.Write "Error " & Err.Number & ": " & Err.Description
    Err.Clear
End If
On Error GoTo 0

' ── What must NOT be treated as built-in ────────────────────────────────────
' These are ordinary names. None of them should colour as a language function,
' and typing a dot after one should offer nothing rather than a member list.
Dim Math, Add, Total, Status, Form, Buffer, Clear

Math   = 1                      ' not a VBScript function
Add    = 2                      ' a COM member name, not a global function
Total  = Math + Add
Status = "ok"                   ' an ASP property name, but this is a variable
Form   = "signup"
Buffer = False
Clear  = "no"

Response.Write Total & Status & Form & CStr(Buffer) & Clear

' A third-party component is unknown, and that is fine — an unknown ProgID
' simply has no member list. It must not throw or offer another type's members.
Dim upload
Set upload = Server.CreateObject("Persits.Upload")
' upload.      → nothing. There is no definition for this component.
%>
<html>
<body>
<p>Rendered by <%= Server.HTMLEncode(Request.ServerVariables("SCRIPT_NAME")) %></p>
</body>
</html>
