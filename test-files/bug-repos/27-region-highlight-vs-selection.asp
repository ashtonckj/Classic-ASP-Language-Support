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
     The ASP tint is now ALWAYS painted in full, everywhere — a selection never
     removes it. The characters you actually select ALSO get the theme's own
     selection colour, layered on top of the tint. Two translucent colours on
     the same text blend, so the selected stretch should look like BOTH at
     once: still tinted red, but visibly selected too — not a plain, flat
     selection with no red in it, and not red with no visible selection either.
     How strongly each one shows through depends on your theme's own selection
     colour (some themes use a fairly opaque one, some a light one), but both
     should be perceptible together.

   WHAT TO LOOK FOR
     1. With the colour above set, click inside the FIRST <% %> block and drag
        to select part of the VBScript. The dragged-over text should look
        selected AND still carry a hint of the red tint — not a plain selection
        with the red gone, and not just red with the selection invisible.
     2. Look at the rest of that SAME block, outside your selection: it must
        still be tinted red, exactly as strongly as before you started
        selecting.
     3. Click once to collapse back to a caret: the selection overlay should
        disappear immediately, leaving the plain red tint behind, unchanged.
     4. Now select something inside the SECOND <% %> block instead. The FIRST
        block must still be fully tinted, completely unaffected.
     5. Multi-cursor: Alt-click a second cursor into the block, then
        shift-click to extend just ONE of the two cursors into a selection.
        Only the actually-selected stretch should show the selection overlay;
        the rest of the block, including text right next to your OTHER cursor,
        stays plain red.
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
