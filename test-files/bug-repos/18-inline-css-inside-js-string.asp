<%@ LANGUAGE="VBSCRIPT" %>
<!--
  The inline style="" validator walks every line of the document looking for
  style=" and then skips the match only when the zone is 'css' or 'asp'. Zone
  'js' is not excluded, so a style attribute written inside a JavaScript string
  is pulled out and validated as CSS.

  WHAT TO LOOK FOR (wait ~1 s — CSS diagnostics are debounced 400 ms)
    1. Line 25 inside the <script> gets a CSS warning from
       "Classic ASP (inline CSS)" for the deliberately bogus property, even
       though it is a JS string literal, not markup.
    2. Line 26 shows the same thing for a valid-looking value with a typo.
    3. CONTROL: line 31 is the same declaration in a VBScript string inside
       <% %> — correctly skipped, because zone 'asp' IS excluded.
    4. CONTROL: line 34 is a real HTML attribute — correctly validated.
-->
<html>
<body>

<script>
  var tpl = '<div style="colour: red">x</div>';
  var tpl2 = '<div style="width: 10qq">y</div>';
</script>

<%
  Dim s
  s = "<div style=""colour: red"">x</div>"
%>

<div style="colour: red">real attribute — warning here is correct</div>

</body>
</html>
