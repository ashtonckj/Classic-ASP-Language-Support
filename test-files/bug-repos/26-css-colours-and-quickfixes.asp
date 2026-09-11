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

   3. EMMET
      There are two routes, and NEITHER needs a setting.

      The first is the suggestion list, which is what a .html file uses: type
      `ul>li*3`, and the abbreviation appears as a completion. Press Tab or Enter
      to accept it and it expands. Ctrl+Space opens the list if it is not already
      showing.

      The second is Tab on its own. Put the caret at the end of the `ul>li*3`
      line and press Tab: it should become a real list. Same for `div.row` and
      `div#main`.

      If NOTHING here works and you see an error naming
      `command 'emmet.expandAbbreviation' not found`, then Emmet itself is
      unavailable in that window — it is a built-in extension and can be
      disabled. Check the Extensions view with the filter `@builtin emmet`; if
      the button says Enable, that is the cause, and no setting in this extension
      can work around it. Tab still inserts a normal indent in that state rather
      than failing.

      Then check what must NOT happen. Put the caret at the end of the plain word
      `Total` and press Tab: it must stay a word and just gain an indent, NOT
      become `<Total></Total>`. Same for `Done.` — prose is not an abbreviation.
      That is the whole reason Tab only expands a token carrying an Emmet marker
      (`>` `+` `^` `*`, or the .class/#id shorthand): an ASP page is mostly body
      text, and VS Code ships `emmet.triggerExpansionOnTab` off precisely because
      with it on, every word expands.

      A bare CSS abbreviation such as `m10` has no marker, so it is
      indistinguishable from a word and does NOT expand on Tab — though the
      suggestion list still offers it. Turn on `emmet.triggerExpansionOnTab` if
      you want Tab to take those too: with it on, every word becomes a candidate,
      in `<style>` and in the body alike.

      Inside the <% %> block, `ul>li*3` must NEVER expand, with or without the
      setting: there it is a comparison between two undeclared variables.
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

  /* Emmet: `m10` needs emmet.triggerExpansionOnTab — no marker to go on. */
  .spaced { m10 }
</style>
</head>
<body>

<!-- Swatches in inline styles too, including two on one line. -->
<td style="color: #abcdef">cell</td>
<i style="color:#aaaaaa">a</i><b style="color:#bbbbbb">b</b>
<div style='background: #123456'>single-quoted attribute</div>

<!-- Emmet: caret at end of line, then Tab. These expand with no settings. -->
ul>li*3
div.row
div#main

<!-- These must NOT expand — a plain word and prose are not abbreviations. -->
Total
Done.

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
