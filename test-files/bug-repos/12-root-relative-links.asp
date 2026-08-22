<%@ LANGUAGE="VBSCRIPT" %>
<!--
  href/src/action links are resolved with path.resolve(directory-of-this-file,
  value). For a root-relative value like "/images/logo.gif" that produces
  C:\images\logo.gif — the drive root, not the site root. Real ASP sites use
  root-relative URLs everywhere, so those links never underline and their path
  completion browses the wrong folder.

  #include virtual="..." already resolves through getVirtualRoot() (the
  workspace folder, or the aspLanguageSupport.virtualRoot setting). The HTML
  link/completion path does not use it.

  WHAT TO LOOK FOR  (open the repo root as the workspace folder)
    1. Line 22 — Ctrl+Click the relative href. It opens 12-link-target.asp.
       This is the control: relative paths work.
    2. Line 23 — the same file addressed root-relatively. No underline, no
       Ctrl+Click, even though the file exists under the workspace root.
    3. Line 24 — put the caret after the "/" and press Ctrl+Space. The
       suggestions list the contents of the DRIVE ROOT (C:\), not the workspace.
    4. Line 27 — the #include equivalent resolves correctly, for comparison.
-->
<a href="12-link-target.asp">relative — works</a>
<a href="/test-files/bug-repros-6/12-link-target.asp">root-relative — no link</a>
<a href="/">completion here lists C:\</a>

<!--#include virtual="/test-files/bug-repros-6/12-link-target.asp"-->
