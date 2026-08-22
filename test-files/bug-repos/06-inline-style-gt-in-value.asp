<%@ Language="VBScript" %>
<!--
  ============================================================================
   Inline style="" detection ends at the first '>' — even one inside the value
  ============================================================================
   The inline-CSS context finder uses indexOf('>') to locate the tag end, so a '>'
   that appears INSIDE the style value (rare, but valid in a content/quoted value)
   is mistaken for the tag close, and no CSS help is offered.

   STEPS: put the caret inside the style value below (after "color:") and press
          Ctrl+Space.
   Expected (buggy): no CSS value suggestions (the '>' in the value confused the
                     tag-end detection).
   Correct: colour values are suggested.
  ============================================================================
-->
<div style="content: '>'; color: re">text</div>

<!-- colour still has issue with the double quotes -->