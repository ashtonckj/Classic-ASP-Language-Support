<%@ Language="VBScript" %>
<%
' ============================================================================
'  Hover's comment-strip mishandles doubled ("") quotes
'  ============================================================================
'  To suppress hovers inside a trailing comment, the hover provider figures out
'  where the comment starts by pairing quotes — but it mis-pairs the VBScript ""
'  escape, so the computed comment position can be wrong.
'
'  STEPS: hover the word  Then  (or  If ) on the line below.
'  Expected (buggy): the hover is shown/suppressed incorrectly because the ""
'                    escape threw off where the ' comment was judged to start.
'  Correct: hovers reflect the true code-vs-comment split.
'
'  NOTE: subtle — depends on the exact quote counting.
' ============================================================================
Dim x
x = "a ""b""" ' If this were code Then it would hover
%>
