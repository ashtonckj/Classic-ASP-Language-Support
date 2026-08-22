<%@ LANGUAGE="VBSCRIPT" %>
<!--#include file="10-goto-def-lib.inc"-->
<!--
  Symbol collection reads an include from the OPEN EDITOR BUFFER (so unsaved
  edits count), but go-to-definition then re-reads the TARGET LINE from DISK to
  work out which column to put the caret on. When the buffer and the file on
  disk disagree, the two disagree too.

  WHAT TO LOOK FOR
    1. Open 10-goto-def-lib.inc.
    2. WITHOUT SAVING, add leading spaces to the `Sub RenderHeader(title)` line
       — e.g. indent it by 8 spaces. (Or rename the sub to `RenderHeaderX` and
       back, so long as the buffer text on that line differs from disk.)
    3. Come back to this file and Ctrl+Click `RenderHeader` on line 24.
    4. It jumps to the right LINE but the caret/selection lands on the wrong
       column — the column was computed from the saved text.
    5. Stronger version: in the .inc buffer, move `Sub RenderHeader` down by
       inserting a blank line above it, still unsaved. Ctrl+Click now selects
       whatever text happens to sit at that column on the disk copy, or falls
       back to column 0.

  CONTROL: save the .inc (Ctrl+S) and Ctrl+Click again — the caret lands
  exactly on the name.
-->
<%
  RenderHeader "Report"
  RenderFooter
%>
