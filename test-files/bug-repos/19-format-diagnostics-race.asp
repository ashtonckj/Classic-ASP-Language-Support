<%@ LANGUAGE="VBSCRIPT" %>
<!--
  Format Document refuses to run when the structure diagnostic collections are
  non-empty. Those collections are filled by a 1500 ms debounced scan, so the
  gate is decided by whatever the collection happened to hold at that instant.

  WHAT TO LOOK FOR — both directions are visible:

    A) FORMATS A BROKEN FILE
       1. Close this file, then reopen it and IMMEDIATELY press Shift+Alt+F
          (within ~1.5 s, before the squiggle on the unclosed <div> appears).
       2. It formats. Wait for the squiggle, press Shift+Alt+F again — now it
          refuses. Same file, same content, two different answers.

    B) REFUSES A FIXED FILE
       1. Wait for the "Missing closing tag" squiggle on line 28.
       2. Add the missing </div> on line 30 and press Shift+Alt+F within 1.5 s.
       3. It still refuses, quoting a structure issue that no longer exists.

  The gate should recompute the scan synchronously at format time rather than
  reading a debounced cache.
-->
<html>
<body>

<div class="outer">
  <p>hello</p>

</body>
</html>
