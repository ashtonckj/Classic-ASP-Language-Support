<%@ Language="VBScript" %>
<!--#include file="inc/helpers.asp"-->
<%
option explicit
dim conn, rs, sql
set conn = server.createobject("ADODB.Connection")
conn.Open application("ConnStr")
sql = "SELECT name, price FROM products WHERE active = 1 ORDER BY name"
set rs = conn.Execute(sql)
%>
<html><head><title>Products</title>
<style>td{padding:4px 8px}</style></head>
<body><table>
<% do while not rs.EOF %>
<tr><td><%= rs("name") %></td><td><%= FormatPrice(rs("price")) %></td></tr>
<% rs.movenext
loop %>
</table></body></html>
