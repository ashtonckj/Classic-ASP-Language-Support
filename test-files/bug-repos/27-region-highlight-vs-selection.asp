<%@ Language="VBScript" %>
<!--
  ============================================================================
   ASP region highlighting was hiding text selection
  ============================================================================
   Reported upstream: the ASP-region background decoration is painted on the
   same layer as the text itself, above VS Code's own selection highlight. With
   a visible enough colour for that background, selecting text inside a <% %>
   block made the SELECTION disappear — the decoration painted right over it.

   This extension's own default colours are deliberately faint
   (rgba(..., 0.04) for the code block, 0.15 for the brackets), so the bug does
   not show with them. To actually see it, set a more visible colour first:

     "aspLanguageSupport.codeBlockLightColor": "rgba(255, 0, 0, 0.5)",
     "aspLanguageSupport.codeBlockDarkColor":  "rgba(255, 0, 0, 0.5)",

   WHAT TO LOOK FOR
     1. With that setting in place, click inside the <% %> block below and
        drag to select some of the VBScript. The selection highlight must
        stay visible the entire time you are dragging — it must NOT be hidden
        by the ASP-region background.
     2. Release the mouse (or otherwise stop selecting) with text still
        selected: the selection must still be visible, and the ASP-region
        background must simply not be painted for as long as the selection
        exists.
     3. Click once to collapse the selection back to a caret: the ASP-region
        background should reappear immediately.
     4. Multi-cursor: Alt-click to add a second cursor elsewhere in the block,
        then shift-click to extend just ONE of the two cursors into a
        selection. Both cursors' regions should stay unhighlighted while
        EITHER selection is non-empty — not just the one under the dragged
        cursor.
     5. Selecting text OUTSIDE the <% %> block (e.g. in the <div> below) is
        unaffected either way, since there was never a background painted
        there to conflict with.

   Revert the two colour settings afterwards — they are only there to make the
   bug visible; the shipped defaults do not reproduce it noticeably.
  ============================================================================
-->
<html>
<body>

<div>Selecting this text was never affected — no ASP region here.</div>

<%
  Dim orderTotal
  Dim orderCount
  orderTotal = 0
  orderCount = 0

  For i = 1 To 5
    orderTotal = orderTotal + i
    orderCount = orderCount + 1
  Next
%>

<p>Total: <%= orderTotal %> across <%= orderCount %> orders.</p>

</body>
</html>
