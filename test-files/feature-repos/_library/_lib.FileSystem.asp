<%
Function ReadTextFile(path)
    Dim fso, stream
    Set fso = Server.CreateObject("Scripting.FileSystemObject")
    Set stream = fso.OpenTextFile(path)
    ReadTextFile = stream.ReadAll()
    stream.Close
End Function
%>
