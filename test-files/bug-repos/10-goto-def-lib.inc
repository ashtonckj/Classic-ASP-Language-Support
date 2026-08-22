<%
' Library used by 10-goto-def-unsaved-include.asp.
' Keep this file EXACTLY as-is on disk — the repro depends on the saved copy
' differing from the buffer after you make the edit described in the .asp.

Sub RenderHeader(title)
    Response.Write "<h1>" & title & "</h1>"
End Sub

Sub RenderFooter()
    Response.Write "<hr>"
End Sub
%>
