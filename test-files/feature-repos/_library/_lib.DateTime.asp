<%
' A "common library" file. Nothing marks this as special to Classic ASP —
' it's just a normal .asp file that happens to only define functions and
' never gets requested directly by a browser.

Function FormatDate(d)
    FormatDate = Year(d) & "-" & Right("0" & Month(d), 2) & "-" & Right("0" & Day(d), 2)
End Function
%>
