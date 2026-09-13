<%
' THIS is "the module" from the feature request.
'
' Notice: no #include directives anywhere in this file. FormatDate() and
' ReadTextFile() are never declared here, and this file's own recursive
' #include chain is empty — it's zero files.
'
' At runtime this still works perfectly: the browser never requests this
' file directly, only layout.asp, which #includes this file AFTER already
' #including the two library files above it. Classic ASP pastes all three
' files together into one script before running it, so by the time this
' code executes, FormatDate and ReadTextFile are both in scope.
'
' But open THIS file by itself in the editor and ask for Go To Definition
' on either call below: the extension has nothing to walk to, because it
' only follows #include directives that exist in the file you have open.
Dim orderDate, orderNotes
orderDate = FormatDate(Now())
orderNotes = ReadTextFile(Server.MapPath("notes.txt"))

Response.Write "<p>Order placed on " & orderDate & "</p>"
Response.Write "<p>" & orderNotes & "</p>"
%>
