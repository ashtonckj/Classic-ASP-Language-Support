<%@ Language="VBScript" %>
<!--
  ============================================================================
   Disagreement on </script> that appears inside a JS string
  ============================================================================
   Per HTML, a literal "</script>" inside a JS string DOES close the <script>
   element. One code path (getZone) follows that; another (getJsRanges, used by
   diagnostics/semantic tokens) does not — so the code after the string is treated
   as JS by one and HTML by the other, making completion/diagnostics inconsistent.

   HOW TO SEE IT: on the alert(1) line below, JS features may be inconsistent —
   e.g. completions/hover behave as if it's not JS, while diagnostics still treat
   it as JS (or vice-versa).
   Correct: both subsystems agree on where the <script> ends.

   NOTE: this is a subtle edge; it may be hard to observe directly.
  ============================================================================
-->
<script>
    var s = "</script>";
    alert(1);
</script>
