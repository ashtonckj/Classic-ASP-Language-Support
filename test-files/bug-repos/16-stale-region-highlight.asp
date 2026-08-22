<%@ LANGUAGE="VBSCRIPT" %>
<!--
  The ASP region background highlight bails out early when a document contains
  no <% %> regions:

      if (!regions || regions.length === 0) return;

  It returns BEFORE calling setDecorations, so the previous run's highlights are
  never cleared — they stay painted over whatever text now occupies those ranges.

  WHAT TO LOOK FOR
    1. Note the tinted background on the <% %> block below (the <% and %>
       brackets are tinted more strongly than the code between them).
    2. Select the whole <% ... %> block on lines 21-23 and delete it.
    3. The tint stays on screen, now sitting on the plain HTML that shifted up
       into those lines.
    4. Type any character — it is still there (each update takes the same early
       return).
    5. Switching to another editor and back repaints correctly, which is what
       makes it look intermittent.

  Related, no fixture: when aspLanguageSupport.highlightAspRegions is set to
  false, the same function disposes and re-creates both decoration types on
  every 200 ms update tick, for a feature that is switched off.
-->
<%
  Dim greeting
  greeting = "hello"
%>
<p>Some HTML that will move up when you delete the block above.</p>
<p>More HTML.</p>
<p>Even more HTML.</p>
