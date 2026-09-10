<%@ Language="VBScript" %>
<!--
  ============================================================================
   Colour swatches, JS quick fixes, and Emmet on Tab
  ============================================================================
   Three separate things to check under F5. They are unrelated to each other, so
   check them independently.

   1. COLOUR SWATCHES
      Every colour below should show a small coloured square immediately to its
      left — in the <style> block AND in the style="" attributes. Click one: the
      colour picker should open, and choosing a new colour should overwrite ONLY
      the old value, leaving the property name and the semicolon alone.

      The `<%= %>` value in the style block must show NO swatch: the server
      decides that colour at runtime, so there is nothing here to pick.

   2. JAVASCRIPT QUICK FIXES
      Each marked line in the <script> block carries a squiggle already. Put the
      caret on it and press Ctrl+. (or click the lightbulb). A fix naming the
      CORRECT spelling should be offered, and accepting it should rewrite just
      that identifier.

      Wait about a second first — the JS diagnostics are debounced 750 ms, and
      the quick fixes are built from the diagnostics that have landed.

   3. EMMET ON TAB
      This one needs a setting: turn on `emmet.triggerExpansionOnTab`. Then put
      the caret at the end of the `ul>li*3` line and press Tab — it should become
      a real list. Same for `div.row`, and for `m10` inside the <style> block
      (which should become `margin: 10px;`).

      With the setting OFF, Tab must just indent — that is VS Code's default for
      .html too, so it is the behaviour to match.

      Inside the <% %> block, `ul>li*3` must NEVER expand: there it is a
      comparison between two undeclared variables, not markup.
  ============================================================================
-->
<html>
<head>
<style>
  /* Each of these should carry a swatch. */
  .row       { color: #f9fbb7; background-color: #fff; }
  .header    { color: rgb(255, 0, 0); border-color: rgba(0, 0, 255, 0.5); }
  .accent    { color: hsl(120, 100%, 50%); outline-color: red; }

  /* NO swatch — the server writes this value. */
  .themed    { color: <%= themeColour %>; }

  /* Emmet: caret at the end of the next line, then Tab. */
  .spaced { m10 }
</style>
</head>
<body>

<!-- Swatches in inline styles too, including two on one line. -->
<td style="color: #abcdef">cell</td>
<i style="color:#aaaaaa">a</i><b style="color:#bbbbbb">b</b>
<div style='background: #123456'>single-quoted attribute</div>

<!-- Emmet: caret at end of line, then Tab. -->
ul>li*3
div.row

<%
  ' Emmet must leave this alone — it is a comparison, not markup.
  ul>li*3
%>

<script type="text/javascript">
  function quickFixTheseSpellings() {
    document.getElementByIdd("btn_save");     // Ctrl+. -> getElementById
    document.body.innerHTMLL = "x";           // Ctrl+. -> innerHTML
    var s = "abc";  s.toUpperCasee();         // Ctrl+. -> toUpperCase
    var n = 5;      n.toFixedd(2);            // Ctrl+. -> toFixed
    var a = [1, 2]; a.pushh(3);               // Ctrl+. -> push
    Math.floorr(1.5);                         // Ctrl+. -> floor
    JSON.parsee("{}");                        // Ctrl+. -> parse
  }
</script>

</body>
</html>
