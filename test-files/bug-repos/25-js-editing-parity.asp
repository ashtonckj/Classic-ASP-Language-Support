<%@ Language="VBScript" %>
<!--
  ============================================================================
   Editing a Classic ASP page should feel like editing HTML
  ============================================================================
   A plain .html file hands its <script> content to the TypeScript server, so
   F12 / Shift+F12 / F2 all work inside it, and the editor picks comment and
   bracket rules from whichever language the caret is actually in. An ASP page
   got none of that: every zone inherited VBScript's rules, and the JS in a
   <script> block had no navigation at all.

   WHAT TO LOOK FOR — five separate things, in order.

   1. COMMENT TOGGLING (Ctrl+/) must match the zone under the caret:
        on the <div> below          -> <!-- ...
        inside the <% %> block      -> ' at the start of the line
        inside <style>              -> /* ... */
        inside <script>             -> // ...
      And Toggle Block Comment (Shift+Alt+A) must NEVER produce <%-- --%>.
      That is ASP.NET syntax; in Classic ASP it is a parse error and the page
      stops running. Inside <% %> there is no block comment, so nothing should
      be inserted at all.

   2. EMMET: put the caret at the end of the `ul>li*3` line and open the
      suggestion list (Ctrl+Space). The abbreviation should be offered; accepting
      it writes a real <ul> with three <li>. It must NOT be offered inside the
      <% %> block, where it is a comparison, not markup.

   3. GO TO DEFINITION (F12) on `addRow` in the SECOND script block should jump
      to its declaration in the FIRST one. F12 on `orderTotal` inside <% %>
      should still reach its Dim, which is the ASP provider's job.

   4. FIND ALL REFERENCES (Shift+F12) on `addRow` should list both the
      declaration and the call in the other block. Clicking `total` should
      highlight its four uses — and NOT the word "total" inside the string on
      the alert line, which is what the old text-matching fallback did.

   5. RENAME (F2) on `total` should rewrite its uses in this page and nothing
      else. F2 on `getElementById` must be REFUSED — renaming a DOM member in
      one page would only break the call. F2 on `RefreshParentGrid` must also be
      refused, with a message saying it is declared on another page: renaming the
      calls here without the parent page's declaration would break it silently.
  ============================================================================
-->
<%
  Dim orderTotal
  orderTotal = 10
%>

<html>
<head>
<style>
  .row { color: red; }
</style>
</head>
<body>

<div>Toggle a comment on this line.</div>

ul>li*3

<script type="text/javascript">
  function addRow(label) {
    var total = 0;
    total = total + 1;
    alert("total");            // the string must not highlight as the variable
    return label + total;
  }

  function refuseTheseRenames() {
    document.getElementById("btn_save");
    window.parent.RefreshParentGrid([1, 2]);
  }
</script>

<script type="text/javascript">
  // F12 here should reach the declaration in the block above.
  addRow("first");
</script>

</body>
</html>
