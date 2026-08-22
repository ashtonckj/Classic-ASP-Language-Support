<%@ Language="VBScript" %>
<%
' ============================================================================
'  SQL recall — SQL built by concatenation / from variables
'  ============================================================================
'  When a query is assembled from string fragments and variables, the SQL keyword
'  colouring is partial or missing, because detection works best on a single
'  self-contained string literal.
'
'  HOW TO SEE IT (open): compare the two below.
'   - The FIRST (one literal) should colour SELECT/FROM/WHERE.
'   - The SECOND (built with & and variables) colours little or nothing.
'
'  This is the "recall" side of SQL detection — the harder, larger effort. Real
'  examples from your own code would help tune it (this also covers the remaining
'  midpoint-gated SQL passes for mixed lines).
' ============================================================================

Dim sql, cols, tbl
cols = "name, email"
tbl  = "users"

' One self-contained literal — should be coloured:
sql = "SELECT name, email FROM users WHERE active = 1"

' Built from fragments + variables — colouring is partial/missing:
sql = "SELECT " & cols & " FROM " & tbl & " WHERE active = 1"
%>
