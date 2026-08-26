<%@ Language="VBScript" %>
<!--#include file="21-rename-scope-lib.inc"-->
<!--
  ============================================================================
   F2 rename rewrites the symbol in EVERY .asp / .inc in the workspace
  ============================================================================
   The rename provider searched the current document, its includes, and then
   walked the workspace folders and added every other .asp / .inc it found —
   whether or not that file has any include relationship to this one. F2 on a
   common name (total, i, id, sql, conn, rs) silently rewrote that word in every
   unrelated page on the site, in a single undo step that is easy to miss.

   Classic ASP has two scopes and no more:
     • procedure scope  — Dim / parameters inside a Sub or Function
     • script scope     — module-level names, shared by a page and every file it
                          transitively #includes (because #include is textual:
                          IIS splices the file in before compiling the page)
   Two pages that share no includes are separate scopes. A scopeTotal here has
   nothing to do with a scopeTotal in 21-rename-scope-unrelated.asp.

   WHAT TO CHECK
     1. Put the caret on `scopeTotal` on line 30 and press F2. Rename it to
        `pageTotal`.
        ✓ this file changes
        ✗ 21-rename-scope-unrelated.asp must NOT change — it cannot see this
          declaration
     2. Ctrl+Z. Open 21-rename-scope-lib.inc, put the caret on `ScopeRender`
        and press F2. Rename it to `ScopeRenderX`.
        ✓ both the .inc AND this page change — this page includes it, so the Sub
          really is in scope here
        ✓ a notification says how many files were touched
     3. Ctrl+Z. Put the caret on `scopeTotal` on line 30 and rename again, then
        look at ScopeAdd in the .inc: its PARAMETER is also called scopeTotal.
        ✗ the parameter and its uses inside ScopeAdd must NOT change — that is a
          different variable
        ✓ ScopeBump, which only assigns scopeTotal without declaring it, MUST
          change: VBScript resolves a bare assignment inside a procedure to the
          module-level variable, so it is the same one
  ============================================================================
-->
<%
  Dim scopeTotal
  scopeTotal = 1
  ScopeAdd 5
  ScopeBump
  ScopeRender
  Response.Write scopeTotal
%>
