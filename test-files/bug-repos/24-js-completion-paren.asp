<%@ Language="VBScript" %>
<!--
  ============================================================================
   Typing an opening paren in a <script> block stopped a debug session
  ============================================================================
   This extension registers '(' as a completion trigger character, so VS Code
   asks for suggestions the moment one is typed. TypeScript's completion API
   accepts only a small set of trigger characters and has no case for '(' —
   it ends at an internal assertion whose failure handler begins with a
   `debugger;` statement and then throws.

   So every '(' typed in a <script> block:
     * under F5, halted the Extension Development Host on that debugger line,
       which looks exactly like a freeze;
     * outside a debug session, threw into the service wrapper's catch, which
       silently returned no suggestions at all.

   WHAT TO LOOK FOR
     Put the caret after each marked paren below and type it again (delete it
     first). Every one of them must:
       1. leave the editor responsive — no pause, no debugger stop;
       2. show a suggestion list of globals and locals.
     Then check the reverse case still works: type a '.' after `document`
     on the last line and confirm the list narrows to document members only.
  ============================================================================
-->
<html>
<body>

<%
  Dim orderId : orderId = Request("id")
%>

<script type="text/javascript">
  // A plain call.
  alert("saved");                       // retype the (

  // A member call.
  document.getElementById("btn_save");  // retype the (

  // A declaration being written — the shape first reported.
  function refreshTotals(rows) {        // retype the (
    var total = 0;
    for (var i = 0; i < rows.length; i++) {
      total = total + Number(rows[i]);  // retype the (
    }
    return total;
  }

  // A function held in a variable.
  var onSave = function (e) {           // retype the (
    refreshTotals([1, 2, 3]);
  };

  // A paren next to an ASP value, so the projection is in play too.
  function loadOrder() {
    fetchOrder(<%= orderId %>);         // retype the (
  }

  // A callback argument.
  window.attachEvent("onload", function () {   // retype the (
    loadOrder();
  });

  // The dot case must still narrow to members, not offer globals.
  document
</script>

</body>
</html>
