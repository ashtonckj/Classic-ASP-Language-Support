<%@ LANGUAGE="VBSCRIPT" %>
<!--
  Rename skips VBScript occurrences that sit on a line where the HTML part
  contains an apostrophe. The occurrence scanner decides "is this token inside a
  VBScript comment?" by reading the physical line from column 0 — so the ' in
  "it's" (plain HTML text) makes it treat the rest of the line as a comment.

  WHAT TO LOOK FOR
    1. Put the caret on `total` on line 18 (the Dim) and press F2.
    2. Rename it to `grandTotal`.
    3. Line 18 and line 24 are renamed. The TWO occurrences on line 21 are NOT.
       You are left with a half-renamed file that no longer runs.

  CONTROL: line 27 is the same construct with "it is" instead of "it's" —
  that one renames correctly. Undo (Ctrl+Z) and try renaming `subtotal` on
  line 26 to see the working case.
-->
<%  Dim total  %>
<table>
  <tr>
    <td>it's here</td><% total = total + 1 %>
  </tr>
</table>
<% Response.Write total %>

<%  Dim subtotal  %>
<td>it is here</td><% subtotal = subtotal + 1 %>
<% Response.Write subtotal %>
