<%@ LANGUAGE="VBSCRIPT" %>
<!--
  Two different indent widths are in play:
    • Enter / Tab smart-indent uses the EDITOR's indent (editor.options.tabSize,
      4 by default).
    • Format Document uses aspLanguageSupport.prettier.tabWidth (2 by default),
      for both the HTML and the VBScript inside <% %>.

  So the extension indents your code one way while you type and a different way
  when you format it.

  WHAT TO LOOK FOR
    1. Make sure the status bar bottom-right reads "Spaces: 4" (the default).
       If your workspace overrides it, set editor.tabSize to 4 for this test.
    2. Put the caret at the end of line 26 (`If ok Then`) and press Enter.
       The new line is indented by 4 spaces.
    3. Type `Response.Write "x"`, press Enter, type `End If`.
    4. Now press Shift+Alt+F. Everything you just typed is re-indented to 2
       spaces — your typing indent and your formatting indent disagree.

    Same effect in HTML: press Enter after a <div> and compare with the result
    of formatting.

  Either the smart-indent handlers should read prettier.tabWidth/useTabs, or the
  formatter should read the editor's — but they should not disagree by default.
-->
<%
  Dim ok
  ok = True
  If ok Then
%>
<div class="panel">
</div>
