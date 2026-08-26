<%
' Library for 21-rename-scope-page.asp.
'
' ScopeAdd's PARAMETER is deliberately called scopeTotal, the same name as the
' module-level variable in the page. Inside this Sub that name is a different
' variable, so renaming the module-level one must leave this body alone.
'
' ScopeBump only ASSIGNS scopeTotal without declaring it. VBScript does not
' create a local on assignment — inside a procedure a bare name resolves to the
' module-level variable when one exists — so this body MUST be renamed with it.

Sub ScopeAdd(scopeTotal)
    scopeTotal = scopeTotal + 1
    Response.Write scopeTotal
End Sub

Sub ScopeBump()
    scopeTotal = scopeTotal + 100
End Sub

Sub ScopeRender()
    Response.Write "<hr>"
End Sub
%>
