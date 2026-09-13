<%@ LANGUAGE="VBSCRIPT" %>
<!--#include file="_library/_lib.DateTime.asp"-->
<!--#include file="_library/_lib.FileSystem.asp"-->
<%
' This is the ONLY file in the whole site that ever #includes the library
' files above. Every request actually goes through here first — a router,
' a header/footer wrapper, whatever your app calls "the layout" — and this
' file then pulls in the requested module by name at the bottom.
%>
<html>
<body>
<!--#include file="orders/view-order.asp"-->
</body>
</html>
