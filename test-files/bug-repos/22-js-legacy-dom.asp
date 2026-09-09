<%@ Language="VBScript" %>
<!--
  ============================================================================
   JavaScript error checking flagged every Internet-Explorer-era API
  ============================================================================
   TypeScript's DOM library — which powers the <script> error squiggles —
   describes MODERN standards-compliant browsers. Classic ASP pages were written
   for IE, so every IE-only API was simply absent from it and got reported as
   "Property 'x' does not exist on type 'y'". A real page could easily collect a
   dozen red squiggles without containing a single actual mistake.

   WHAT TO LOOK FOR
     Open this file and wait about a second (JS diagnostics are debounced 750 ms).
     There are two <script> blocks:
       1. legacy APIs and cross-frame calls — must be completely CLEAN
       2. deliberate mistakes — must ALL still squiggle, which is the half that
          matters: widening the types must not stop real typos being reported
  ============================================================================
-->
<html>
<body>

<form name="f_order">
  <select name="O1" onchange="if(Number(this.value)<=50){alert('no');return false};">
    <option value="1">one</option>
  </select>
  <button type="button" id="btn_save">Save</button>
</form>

<table>
  <tr onmouseover="row_onmouseover()"><td>cell</td></tr>
</table>

<%
  Dim callback : callback = Request("callback")
  Dim orderId  : orderId  = Request("id")
%>

<!-- ── These must all be CLEAN ─────────────────────────────────────────────-->
<script type="text/javascript">
  // The IE event-attach model.
  if (window.attachEvent) {
    window.attachEvent("onload", pageReady);
  } else if (window.addEventListener) {
    window.addEventListener("load", pageReady, false);
  }

  // Looking an element up by name on a collection — real browser behaviour that
  // the typings do not describe.
  document.forms.f_order.O1.value = "<%= orderId %>";
  document.all.btn_save.style.display = "";
  document.forms[0].elements.O1.value = "1";

  // The IE event model hands the target over as event.srcElement, which the
  // typings give almost no members.
  function row_onmouseover() {
    if (event.srcElement.tagName == "TD") {
      event.srcElement.parentElement.style.backgroundColor = "#f9fbb7";
      event.srcElement.parentElement.style.color = "Black";
      event.srcElement.setAttribute("data-hover", "1");
    }
  }

  // Reaching into another frame. Nothing in THIS file can describe what lives
  // in the parent page, so there is no information to check these against.
  function closeMe(retVal) {
    <%if(callback<>"") then%>
      if (typeof(top.<%=callback%>) == "function") { top.<%=callback%>(retVal); }
    <%else%>
      try { parent.$("#myModalWindow").dialog("close"); } catch (e) {}
    <%end if%>
  }

  // A function that lives on the PARENT page, called by name. Its name is
  // specific to this page, so the extension reads it out of the document and
  // declares it. See 23-js-cross-frame.asp for the dedicated test.
  function pushToParent(vals) {
    if (window.parent && window.parent.RefreshParentGrid) {
      window.parent.RefreshParentGrid(vals);
    }
  }

  // Other IE-era globals.
  function legacyExtras() {
    window.execScript("var x = 1;");
    document.selection.createRange();
    document.createStyleSheet("extra.css");
  }
</script>

<!-- ── These must all STILL be flagged ─────────────────────────────────────-->
<script type="text/javascript">
  function deliberateMistakes() {
    document.getElementByIdd("btn_save");        // misspelt document method
    document.body.innerHTMLL = "x";              // misspelt element member
    document.body.styl.color = "red";            // misspelt style property
    window.docuemnt.getElementById("x");         // misspelt window property
    window.thisDoesNotExist();                   // unknown window property
    var s = "abc"; s.toUpperCasee();             // misspelt string method
    var n = 5;     n.toFixed(2).charAtt(0);      // misspelt number/string method
    var a = [1, 2]; a.pushh(3);                  // misspelt array method
    Math.floorr(1.5);                            // misspelt Math method
    JSON.parseX("{}");                           // misspelt JSON method
    console.logg("hi");                          // misspelt console method
  }
</script>

</body>
</html>
