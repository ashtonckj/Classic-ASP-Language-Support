<%@ LANGUAGE="VBSCRIPT" %>
<!--
  THIS FILE IS SAVED WITH CRLF LINE ENDINGS ON PURPOSE.
  Check the status bar bottom-right — it must read CRLF. If it reads LF (git
  may have converted it on checkout), click it and switch to CRLF, save, then
  reopen before testing.

  The formatter runs Prettier with endOfLine defaulting to "lf", so its output
  has no CR at all. The edit builder then diffs the CRLF original against the LF
  formatted text line by line — every line looks changed, so the whole document
  is replaced in one edit instead of only the lines that really moved.

  WHAT TO LOOK FOR
    1. Only ONE line below is badly indented (the <p> on line 24).
    2. Press Shift+Alt+F.
    3. Watch the editor gutter / the scrollbar overview ruler: the ENTIRE file
       is marked as changed, and the caret jumps to the end of the document.
    4. Compare with 13b-format-lf.asp (identical content, LF endings): there,
       only the one wrong line is touched and the caret stays put.

  WORKAROUND THAT CONFIRMS THE CAUSE
    Set "aspLanguageSupport.prettier.endOfLine": "auto" and format again —
    only the one line changes. That is probably the right default.
-->
<html>
<body>
<div class="panel">
        <p>only this line is mis-indented</p>
</div>
</body>
</html>
