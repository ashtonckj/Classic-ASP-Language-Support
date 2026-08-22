<%@ Language="VBScript" %>
<!--
  ============================================================================
   <script language="vbscript"> body offset can land in an attribute value
  ============================================================================
   The semantic colourer finds the body start with indexOf(bodyText), so when the
   body text also appears earlier inside an attribute value, it marks the wrong
   span as VBScript.

   HOW TO SEE IT (open): the block below has the SAME text ( x=1 ) in the title
   attribute and in the body. The VBScript colouring/zone may attach to the
   attribute's  x=1  instead of the body's.
   Expected (buggy): the body's  x = 1  is not coloured (or the attribute is).
   Correct: only the body between > and </script> is treated as VBScript.
  ============================================================================
-->
<script language="vbscript" title="x=1">
x = 1
Response.Write x
</script>
