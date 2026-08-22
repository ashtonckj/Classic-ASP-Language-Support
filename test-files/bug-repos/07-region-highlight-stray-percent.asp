<%@ Language="VBScript" %>
<!--
  ============================================================================
   BUG N — a stray "%>" in HTML text breaks the <% %> background highlighting
  ============================================================================
   The "highlight ASP regions" feature (on by default) tints <% %> code blocks
   with a background colour. It finds the tags with a blind regex and pairs them
   two-at-a-time, without checking which is an opener — so a literal "%>" sitting
   in ordinary HTML (here, inside "50%>") is treated as an opening bracket and
   throws off the pairing for everything after it.

   HOW TO SEE IT: look at the background tint on the two real <% %> blocks below.
   Expected (buggy): the tint is applied to the wrong spans — e.g. the HTML text
     between "50%>" and the first <% gets the code-block background, and the real
     <% x = 1 %> / <% y = 2 %> blocks are tinted wrong or not at all.
   Correct behaviour: only the real <% ... %> blocks are tinted.

   (If you can't see it, toggle aspLanguageSupport.highlightAspRegions or pick a
    stronger colour in the settings to make the tint obvious.)
  ============================================================================
-->
<p>Battery level reached 50%></p>

<% x = 1 %>

<p>Some text in between.</p>

<% y = 2 %>
