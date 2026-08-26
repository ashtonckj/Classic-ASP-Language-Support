<%@ Language="VBScript" %>
<!--
  Control for 21-rename-scope-page.asp.

  This page includes nothing and is included by nothing, so its scopeTotal is a
  completely separate variable. Renaming scopeTotal in 21-rename-scope-page.asp
  must leave every line below untouched.
-->
<%
  Dim scopeTotal
  scopeTotal = 42
  Response.Write scopeTotal
%>
