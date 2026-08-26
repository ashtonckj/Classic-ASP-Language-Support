<%@ Language="VBScript" %>
<!--
  ============================================================================
   Format Document splits the <%@ ... %> processing directive across three lines
  ============================================================================
   The formatter treats the directive on line 1 like any other single-line ASP
   block, so it emits

       <%
       @ Language = "VBScript"
       %>

   IIS only recognises the directive in the exact form `<%@ ... %>`. Once a
   newline separates the @ from the <%, the page is compiled as ordinary
   VBScript and `@ Language = "VBScript"` is a syntax error — every page that
   was formatted stops loading. Keyword casing / operator spacing also rewrote
   the directive text (note the spaces added around the =).

   HOW TO SEE IT
     1. Press Shift+Alt+F.
     2. Look at line 1. It must still read exactly:  <%@ Language="VBScript" %>
        If it became a three-line block, the bug is present.
     3. Ctrl+Z, then try the multi-directive variant at the bottom of this file.

   Both forms must survive formatting unchanged.
  ============================================================================
-->
<html>
<body>
<div class="panel">
        <p>only this line is mis-indented, so only it should change</p>
</div>
</body>
</html>
