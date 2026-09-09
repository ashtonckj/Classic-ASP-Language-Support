<%@ Language="VBScript" %>
<!--
  ============================================================================
   Calling a function on another page was reported as a mistake
  ============================================================================
   Classic ASP apps are built out of frames and modal windows, so a page
   routinely calls back into the one that opened it:

       window.parent.RefreshParentGrid(vals);
       if (typeof(top.myCallback) == "function") { top.myCallback(retVal); }

   The receiver is typed Window, which of course has no RefreshParentGrid, so
   the JavaScript checker reported "Property 'RefreshParentGrid' does not exist
   on type 'Window'" on every one of them.

   Nothing could verify those calls either — the function lives in a DIFFERENT
   document that this file cannot see, so the checker has no information to work
   with in either direction. The extension now reads the names out of the
   document and declares them, which hides no bug because there was no check to
   give up.

   The important half is the boundary: a name reached through parent / top /
   opener is another document's business, but a plain window.something is THIS
   page's business and stays checked.

   WHAT TO LOOK FOR
     Open this file and wait about a second (JS diagnostics are debounced 750 ms).
       Block 1 — cross-frame calls        → must be completely CLEAN
       Block 2 — same-frame and typos     → must ALL still squiggle
  ============================================================================
-->
<html>
<body>

<%
  Dim callback : callback = Request("callback")
  Dim rowId    : rowId    = Request("id")
%>

<button type="button" id="btn_save" onclick="saveAndClose()">Save</button>

<!-- ── Block 1: must be completely CLEAN ───────────────────────────────────-->
<script type="text/javascript">
  // The commonest shape: a modal telling the page behind it to refresh.
  function saveAndClose() {
    if (window.parent && window.parent.RefreshParentGrid) {
      window.parent.RefreshParentGrid(<%= rowId %>);
    }
    if (window.parent.PridelenoZpracovatel_CheckAndAppendFromVals) {
      window.parent.PridelenoZpracovatel_CheckAndAppendFromVals(1);
    }
  }

  // A callback whose NAME is chosen by VBScript at request time.
  function notifyCaller(retVal) {
    <%if(callback<>"") then%>
      if (typeof(top.<%=callback%>) == "function") { top.<%=callback%>(retVal); }
      else if (typeof(parent.<%=callback%>) == "function") { parent.<%=callback%>(retVal); }
    <%else%>
      try { parent.$("#myModalWindow").dialog("close"); } catch (e) {}
    <%end if%>
  }

  // top / opener / chained frame walks.
  function otherFrameShapes() {
    top.SetStatusBarText("saved");
    opener.reloadOrderList();
    parent.parent.NotifyRootFrame("done");
    window.top.CloseAllModals();
  }

  // Real Window members reached through a frame keep working — they are NOT
  // harvested, so they keep their proper types rather than becoming `any`.
  function realWindowMembers() {
    parent.document.getElementById("hdr");
    parent.location.href = "list.asp";
    top.close();
    parent.focus();
  }
</script>

<!-- ── Block 2: must ALL still be flagged ──────────────────────────────────-->
<script type="text/javascript">
  function deliberateMistakes() {
    // Same-frame globals are THIS page's business, so a typo is still a typo.
    window.docuemnt.getElementById("x");         // misspelt window property
    window.thisWasNeverDefined();                // unknown same-frame global

    // And a frame call must not switch off checking for the rest of the block.
    parent.RefreshParentGrid();                  // (this line is fine)
    document.getElementByIdd("btn_save");        // misspelt document method
    document.body.innerHTMLL = "x";              // misspelt element member
    parent.location.hrefff = "list.asp";         // misspelt member on a real Window
  }
</script>

</body>
</html>
