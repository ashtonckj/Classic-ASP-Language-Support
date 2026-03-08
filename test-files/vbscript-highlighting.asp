<%
' vbscript-highlighting.asp — VBScript semantic token colouring test


' ── SECTION 1  Variable and constant declarations ─────────────────────────────

Dim userName, userAge, isActive
Dim score, maxScore, minScore
ReDim scores(10)

Public totalCount
Private errorMessage

Const MAX_RETRIES = 3
Const APP_NAME = "TestApp"
Const PI = 3.14159


' ── SECTION 2  Assignments and expressions ───────────────────────────────────

userName    = "Alice"
userAge     = 30
isActive    = True
score       = 42
errorMessage = ""

totalCount  = userAge + score
maxScore    = 100
minScore    = 0


' ── SECTION 3  If / ElseIf / Else / End If ───────────────────────────────────

If score >= 90 Then
    grade = "A"
ElseIf score >= 75 Then
    grade = "B"
ElseIf score >= 50 Then
    grade = "C"
Else
    grade = "F"
End If

' Inline If
If isActive Then Response.Write "Active"

' Nested If
If userAge >= 18 Then
    If score > maxScore Then
        score = maxScore
    End If
End If


' ── SECTION 4  Select Case ───────────────────────────────────────────────────

Select Case grade
    Case "A"
        label = "Excellent"
    Case "B"
        label = "Good"
    Case "C"
        label = "Average"
    Case Else
        label = "Below Average"
End Select


' ── SECTION 5  For / Next ────────────────────────────────────────────────────

' Basic counter loop
For i = 1 To 10
    total = total + i
Next

' With Step
For i = 10 To 1 Step -1
    countdown = countdown & i & " "
Next

' Exit For
For i = 0 To UBound(scores)
    If scores(i) = 0 Then Exit For
    runningTotal = runningTotal + scores(i)
Next


' ── SECTION 6  For Each / Next ───────────────────────────────────────────────

Dim itemList
Set itemList = Server.CreateObject("Scripting.Dictionary")
itemList.Add "one", 1
itemList.Add "two", 2

For Each key In itemList
    Response.Write key & " = " & itemList(key) & "<br>"
Next


' ── SECTION 7  While / Wend ──────────────────────────────────────────────────

Dim attempts
attempts = 0

While attempts < MAX_RETRIES
    attempts = attempts + 1
Wend


' ── SECTION 8  Do / Loop variants ────────────────────────────────────────────

' Do While
Dim cursor
cursor = 0
Do While cursor < 5
    cursor = cursor + 1
Loop

' Do Until
Do Until cursor = 10
    cursor = cursor + 1
Loop

' Do / Loop While (post-condition)
Do
    cursor = cursor - 1
Loop While cursor > 0

' Do / Loop Until (post-condition)
Do
    cursor = cursor + 1
Loop Until cursor >= 5

' Exit Do
Do While True
    If cursor > 100 Then Exit Do
    cursor = cursor + 1
Loop


' ── SECTION 9  Functions and Subs ────────────────────────────────────────────

Function Add(a, b)
    Add = a + b
End Function

Function Clamp(value, minVal, maxVal)
    If value < minVal Then
        Clamp = minVal
    ElseIf value > maxVal Then
        Clamp = maxVal
    Else
        Clamp = value
    End If
End Function

Sub LogMessage(msg)
    Response.Write "[LOG] " & msg & "<br>"
End Sub

Sub ResetCounters()
    total        = 0
    attempts     = 0
    runningTotal = 0
End Sub

' ByVal / ByRef parameters
Function Multiply(ByVal x, ByVal y)
    Multiply = x * y
End Function

Sub Increment(ByRef n)
    n = n + 1
End Sub

' Exit Function / Exit Sub
Function SafeDivide(a, b)
    If b = 0 Then
        SafeDivide = 0
        Exit Function
    End If
    SafeDivide = a / b
End Function

Sub EarlyOut(flag)
    If Not flag Then Exit Sub
    Response.Write "Proceeded"
End Sub


' ── SECTION 10  On Error / Err object ────────────────────────────────────────

On Error Resume Next

Dim conn
Set conn = Server.CreateObject("ADODB.Connection")
conn.Open "DSN=TestDB"

If Err.Number <> 0 Then
    errorMessage = Err.Description
    Err.Clear
End If

On Error GoTo 0


' ── SECTION 11  With block ───────────────────────────────────────────────────

Dim rs
Set rs = Server.CreateObject("ADODB.Recordset")

With rs
    .CursorType = 3
    .LockType   = 1
    .Open "SELECT * FROM dbo.Users", conn
    Do While Not .EOF
        Response.Write .Fields("Name") & "<br>"
        .MoveNext
    Loop
    .Close
End With


' ── SECTION 12  Set / Nothing / Is ───────────────────────────────────────────

Set rs   = Nothing
Set conn = Nothing

If conn Is Nothing Then
    Response.Write "Connection released"
End If


' ── SECTION 13  Option Explicit ──────────────────────────────────────────────

' Option Explicit is typically at the top of the file — shown here for testing.
' Option Explicit


' ── SECTION 14  Operators and logical keywords ───────────────────────────────

Dim a, b, result

a = 10
b = 3

result = a Mod b          ' Mod
result = a \ b            ' integer division
result = Not isActive     ' Not
result = isActive And True
result = isActive Or False
result = isActive Xor True
result = isActive Eqv True
result = isActive Imp False


' ── SECTION 15  Type-check and conversion functions ──────────────────────────

Dim raw
raw = "42"

If IsNumeric(raw) Then score = CInt(raw)
If IsDate(raw)    Then logDate = CDate(raw)
If IsNull(raw)    Then raw = ""
If IsEmpty(raw)   Then raw = "default"
If IsArray(scores) Then Response.Write "Is array"

result = CStr(score) & " " & CInt("5") & " " & CDbl("3.14")


' ── SECTION 16  String and array builtins ────────────────────────────────────

Dim parts
parts = Split("one,two,three", ",")
Response.Write UBound(parts)
Response.Write Join(parts, " | ")
Response.Write Len(userName)
Response.Write UCase(userName) & " " & LCase(userName)
Response.Write Trim("  hello  ")
Response.Write Left(userName, 3) & Right(userName, 3)
Response.Write Mid(userName, 2, 2)
Response.Write InStr(userName, "l")
Response.Write Replace(userName, "A", "a")

%>
