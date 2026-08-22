<%@ LANGUAGE="VBSCRIPT" %>
<!--
  Same root cause as fixture 01, but on the zone resolver instead of the
  diagnostics scanner. A literal "<" in HTML text is treated as the start of a
  tag, and the scanner then reads until the next ">" — which is the ">" of the
  <script> / <style> tag itself. The whole embedded block is never recognised.

  WHAT TO LOOK FOR
    A) JS — in the <script> on line 26:
         - `notAFunction(` gives no signature help / no red squiggle for the
           unknown name (JS error checking is off in this block).
         - Type `docu` and Ctrl+Space -> no `document` suggestion.
    B) CSS — in the <style> on line 34:
         - Put the caret after `col` and press Ctrl+Space -> no CSS property list.
         - `colour: red;` (a typo) gets no "unknown property" warning.

    C) CONTROL — the second pair (lines 42 / 50) is identical except the prose
       uses &lt;. There, JS and CSS IntelliSense both work.
-->
<html>
<body>

<p>Show rows where qty < 5</p>
<script>
  notAFunction(1);
  var x = docu
</script>

<p>Show rows where qty < 5</p>
<style>
  .warn { col
    colour: red;
  }
</style>

<hr>

<p>Show rows where qty &lt; 5</p>
<script>
  notAFunction(1);
  var y = docu
</script>

<p>Show rows where qty &lt; 5</p>
<style>
  .ok { col
    colour: red;
  }
</style>

</body>
</html>
