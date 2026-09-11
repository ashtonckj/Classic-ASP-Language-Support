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

   HOW THE FIX WORKS (so you know what "correct" looks like)
     Only the exact characters you select switch away from the ASP tint — they
     get the theme's own selection colour instead, so that stretch looks like a
     completely normal selection. Everything else keeps its tint: the rest of
     the SAME <% %> block before/after your selection, and every OTHER <% %>
     block in the file, whether or not you are currently selecting something
     elsewhere. The tint is never hidden document-wide just because a selection
     exists somewhere.

   WHAT TO LOOK FOR
     1. With the colour above set, click inside the FIRST <% %> block and drag
        to select part of the VBScript. The dragged-over text must look like a
        normal selection the whole time — not swallowed by the red tint.
     2. Look at the rest of that SAME block, outside your selection: it must
        still be tinted red, undisturbed.
     3. Click once to collapse back to a caret: the tint should reappear over
        the exact characters you had selected, immediately.
     4. Now select something inside the SECOND <% %> block instead. The FIRST
        block must still be fully tinted, completely unaffected — this is the
        part that was wrong before: selecting anywhere used to blank out every
        <% %> block in the whole file, not just the one you were touching.
     5. Multi-cursor: Alt-click a second cursor into the block, then
        shift-click to extend just ONE of the two cursors into a selection.
        Only the actually-selected stretch should lose its tint; the rest of
        the block, including text right next to your OTHER cursor, stays
        tinted.
     6. Selecting text OUTSIDE any <% %> block (the <div> below) is unaffected,
        since there was never a tint there to conflict with.

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

<%
  ' A second, separate block — selecting inside the first one above must
  ' never affect the tint on this one, and vice versa.
  Dim greeting
  greeting = "Hello"
%>

<p><%= greeting %>, thank you for your order.</p>

</body>
</html>
