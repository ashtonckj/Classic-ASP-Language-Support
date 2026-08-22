<%@ LANGUAGE="VBSCRIPT" %>
<!--
  Rename is offered inside a <script language="vbscript"> block (the zone
  resolver correctly calls it VBScript), but the occurrence scanner only maps
  <% ... %> blocks — so it finds nothing and the rename silently does nothing.

  WHAT TO LOOK FOR
    1. Put the caret on `total` on line 18 and press F2 — the rename box opens
       and pre-fills "total", so the feature claims to support this position.
    2. Type `grandTotal` and press Enter.
    3. Nothing changes. No error, no edit. Same for `Greet` in the server-side
       block below.

  CONTROL: `pageCount` in the <% %> block at the bottom renames normally.
-->
<script language="vbscript">
  Dim total
  total = 1
  Response.Write total
</script>

<script runat="server" language="vbscript">
  Sub Greet(name)
    Response.Write "Hello " & name
  End Sub
</script>

<%
  Dim pageCount
  pageCount = 1
  Response.Write pageCount
%>
