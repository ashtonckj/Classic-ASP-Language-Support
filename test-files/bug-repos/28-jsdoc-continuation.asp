<%@ Language="VBScript" %>
<!--
  ============================================================================
   JSDoc continuation on Enter, inside a <script> block
  ============================================================================
   A plain .js file gets this from the TypeScript extension's own built-in
   rules. A <script> block in an ASP page had none of its own: pressing Enter
   right after `/**` just left a bare newline at the same indent, and pressing
   Enter on an existing ` * ` line did not continue the star column either.

   WHAT TO LOOK FOR
     1. On the blank line marked (1), type `/**` and press Enter. It should
        expand to:
          /**
           * <cursor here>
           */
        with the caret on the middle line, and the stars aligned one column
        to the right of the `/**` above them.

     2. On the line marked (2), which already has a JSDoc comment open, put the
        caret at the end of " * Adds two numbers." and press Enter. It should
        continue with a fresh `` * `` at the SAME column — not just a bare
        indented line — and the existing `*/` below must stay exactly where
        it was.

     3. Inside the <% %> block below, type `/**` and press Enter. This must
        NOT expand into a JSDoc skeleton — VBScript has no block comments at
        all, so `/**` there is just two operators (divide, then multiply)
        parsed as ordinary (if nonsensical) code. Only a <script> block should
        ever trigger this.
  ============================================================================
-->
<html>
<body>

<script type="text/javascript">
  // (1) Blank line below: type /** then press Enter.


  /**
   * (2) Adds two numbers.
   * @param {number} a
   * @param {number} b
   */
  function add(a, b) {
    return a + b;
  }
</script>

<%
  ' (3) Type /** on the next line, then press Enter — must stay plain VBScript.
  Dim total
%>

</body>
</html>
