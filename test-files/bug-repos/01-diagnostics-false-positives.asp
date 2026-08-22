<%@ Language="VBScript" %>
<%
' ============================================================================
'  BUGS A & B — FALSE-POSITIVE DIAGNOSTICS (visible the moment you OPEN this)
'
'  You do NOT need to format this file. Just open it and look for red/yellow
'  squiggles. Everything below is VALID Classic ASP + HTML, so there should be
'  NO squiggles at all. Any squiggle here is a false positive (the bug).
'
'  Bonus: because "Format Document" is blocked whenever there are structure
'  diagnostics, these false positives ALSO make real pages impossible to format.
' ============================================================================
%>

<!-- ── BUG A: HTML prose next to <%= %> is mis-read as a VBScript block opener ──
     Expected (buggy): squiggles like
        "Missing closing keyword — no 'End With' found for this 'With'"
        "... no 'Loop' found for this 'Do'"
     The words with / do / class in ordinary text are treated as VB keywords. -->
<table>
  <tr><td>Total: <%= 42 %> items with tax</td></tr>
  <tr><td>What to do <%= "later" %> today</td></tr>
  <tr><td>See class notes for item <%= 7 %></td></tr>
</table>

<!-- ── BUG B: a valid table with omitted (optional) </td> and </tr> ────────────
     </td>, </tr>, </th>, </thead>, </tbody> are OPTIONAL per the HTML spec, so
     this markup is 100% valid and renders fine in every browser.
     Expected (buggy): a "Missing closing tag" squiggle on every <td> and <tr>. -->
<table>
  <tr>
    <td>apple
    <td>banana
  <tr>
    <td>cherry
    <td>date
</table>

<p>End of file. If you see squiggles above, both bugs are real.</p>
