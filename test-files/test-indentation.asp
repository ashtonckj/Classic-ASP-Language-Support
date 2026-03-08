<%
' test-indentation.asp
' Smart indentation & auto-snap test  (indent size: 4 spaces)
'
' HOW TO USE:
'   Read the ACTION comment above each block, place your cursor where the
'   arrow shows  (←)  and press the key described.
'   EXPECTED tells you what the next line should look like.
'
' LEGEND:
'   ←         place cursor here before pressing the key
'   [Enter]   press Enter / Return
'   [Tab]     press Tab on a blank line
'   col N     character column, counting from 0


' ══════════════════════════════════════════════════════════════════════════════
' PART A — [Enter] after block openers
'
' After pressing [Enter] at the  ←  mark the new line should be
' indented one level (+4 spaces) deeper than the opener.
' ══════════════════════════════════════════════════════════════════════════════

' ── A1. If / Then ────────────────────────────────────────────────────────────
' ACTION:  cursor at end of "If condition Then"  ←  then [Enter]
' EXPECTED: new line at col 4

If condition Then
    Response.Write "inside If"
End If

' ── A2. ElseIf / Else ────────────────────────────────────────────────────────
' ACTION:  cursor at end of "ElseIf otherCondition Then"  ←  then [Enter]
' EXPECTED: new line at col 4  (body of ElseIf)
' ACTION:  cursor at end of "Else"  ←  then [Enter]
' EXPECTED: new line at col 4  (body of Else)
' ACTION:  cursor at end of "End If"  ←  then [Enter]
' EXPECTED: new line at col 0  (back to If level)

If condition Then
    Response.Write "A"
ElseIf otherCondition Then
    Response.Write "B"
Else
    Response.Write "C"
End If

' ── A3. For / Next ───────────────────────────────────────────────────────────
' ACTION:  cursor at end of "For i = 1 To 10"  ←  then [Enter]
' EXPECTED: new line at col 4

For i = 1 To 10
    total = total + i
Next

' ── A4. For Each / Next ──────────────────────────────────────────────────────
' ACTION:  cursor at end of "For Each item In itemList"  ←  then [Enter]
' EXPECTED: new line at col 4

For Each item In itemList
    Response.Write item
Next

' ── A5. While / Wend ─────────────────────────────────────────────────────────
' ACTION:  cursor at end of "While x < 10"  ←  then [Enter]
' EXPECTED: new line at col 4

While x < 10
    x = x + 1
Wend

' ── A6. Do While / Loop ──────────────────────────────────────────────────────
' ACTION:  cursor at end of "Do While Not rs.EOF"  ←  then [Enter]
' EXPECTED: new line at col 4

Do While Not rs.EOF
    Response.Write rs("Name")
    rs.MoveNext
Loop

' ── A7. Do / Loop Until  (post-condition) ────────────────────────────────────
' ACTION 1:  cursor at end of "Do"  ←  then [Enter]
' EXPECTED:  new line at col 4
' ACTION 2:  cursor at end of "Loop Until cursor >= 10"  ←  then [Enter]
' EXPECTED:  new line at col 0  (back to Do level, Loop closes the block)

Do
    cursor = cursor + 1
Loop Until cursor >= 10

' ── A8. Do / Loop While  (post-condition) ────────────────────────────────────
' This is the tricky case: "Loop While" must NOT open a new While block.
' ACTION 1:  cursor at end of "Do"  ←  then [Enter]
' EXPECTED:  new line at col 4
' ACTION 2:  cursor at end of "Loop While cursor > 0"  ←  then [Enter]
' EXPECTED:  new line at col 0  (Loop closes block — While here is NOT an opener)

Do
    cursor = cursor - 1
Loop While cursor > 0

' ── A9. Select Case ──────────────────────────────────────────────────────────
' ACTION:  cursor at end of "Select Case status"  ←  then [Enter]
' EXPECTED: new line at col 4  (Case label level, one inside Select)
' ACTION:  cursor at end of "Case ....."  ←  then [Enter]
' EXPECTED: new line at col 8  (body, one level inside the Case label)
' ACTION:  type "End Select" at col 0  — it should snap to col 0

Select Case status
    Case "active"
        Response.Write "Active"
    Case "pending"
        Response.Write "Pending"
    Case Else
        Response.Write "Unknown"
End Select

' ── A10. Function / End Function ─────────────────────────────────────────────
' ACTION:  cursor at end of "Function CalculateTotal(...)"  ←  then [Enter]
' EXPECTED: new line at col 4

Function CalculateTotal(qty, price)
    Dim total
    total = qty * price
    CalculateTotal = total
End Function

' ── A11. Sub / End Sub ───────────────────────────────────────────────────────
' ACTION:  cursor at end of "Sub LogMessage(msg)"  ←  then [Enter]
' EXPECTED: new line at col 4

Sub LogMessage(msg)
    Response.Write "[LOG] " & msg
End Sub

' ── A12. With / End With ─────────────────────────────────────────────────────
' ACTION:  cursor at end of "With rs"  ←  then [Enter]
' EXPECTED: new line at col 4
' NOTE:  "End With" must NOT trigger a new indent — it is a closer only.

With rs
    .Open stmt, conn
    .Close
End With

' ── A13. Class / End Class ───────────────────────────────────────────────────
' ACTION:  cursor at end of "Class UserModel"  ←  then [Enter]
' EXPECTED: new line at col 4

Class UserModel
    Private mName
    Public Property Get Name
        Name = mName
    End Property
End Class


' ══════════════════════════════════════════════════════════════════════════════
' PART B — Auto-snap: type a closer at the WRONG indent, watch it snap
'
' For each block below, deliberately TYPE the closer keyword at the wrong
' column.  The auto-snap should move it to the column shown in the comment.
' ══════════════════════════════════════════════════════════════════════════════

' ── B1. End If — top-level  (type at col 8, snaps to col 0) ──────────────────

If condition Then
    Response.Write "test"
End If

' ── B2. End If — nested  (type inner "End If" at col 0, snaps to col 4) ──────

If outer Then
    If inner Then
        Response.Write "nested"
    End If
End If

' ── B3. Else  (type at col 8, snaps to col 0) ────────────────────────────────

If condition Then
    Response.Write "yes"
Else
    Response.Write "no"
End If

' ── B4. ElseIf  (type at col 8, snaps to col 0) ──────────────────────────────

If score >= 90 Then
    grade = "A"
ElseIf score >= 75 Then
    grade = "B"
Else
    grade = "C"
End If

' ── B5. Next  (type at col 8, snaps to col 0) ────────────────────────────────

For i = 1 To 5
    total = total + i
Next

' ── B6. Loop  (type at col 8, snaps to col 0) ────────────────────────────────

Do While cursor < 10
    cursor = cursor + 1
Loop

' ── B7. Wend  (type at col 8, snaps to col 0) ────────────────────────────────

While x < 10
    x = x + 1
Wend

' ── B8. Case  (type at col 0, snaps to col 4) ────────────────────────────────

Select Case grade
    Case "A"
        label = "Excellent"
    Case "B"
        label = "Good"
End Select

' ── B9. Deeply nested — every closer at the right column ─────────────────────
' Try typing each closer at col 0 and verify the snap column matches the comment.
'
'   Function ProcessBatch    col 0
'       For Each             col 4
'           If IsNull        col 8
'               item = ""   col 12
'           ElseIf           col 8  (snap)
'           Else             col 8  (snap)
'               Select Case  col 12
'                   Case "A" col 16  (snap)
'                   Case Else col 16  (snap)
'               End Select   col 12  (snap)
'           End If           col 8  (snap)
'       Next                 col 4  (snap)
'   End Function             col 0  (snap)

Function ProcessBatch(items)
    For Each item In items
        If IsNull(item) Then
            item = ""
        ElseIf item = "skip" Then
            ' do nothing
        Else
            Select Case item
                Case "A"
                    count = count + 1
                Case Else
                    other = other + 1
            End Select
        End If
    Next
End Function


' ══════════════════════════════════════════════════════════════════════════════
' PART C — [Enter] after string continuation  (& _)
'
' [Enter] after a  & _  line  →  cursor aligns to the  "  column of the
'                                 first string on the statement.
' [Enter] after the last line (no _)  →  cursor snaps back to the
'                                        indent of the assignment.
' ══════════════════════════════════════════════════════════════════════════════

' ── C1. Basic alignment ──────────────────────────────────────────────────────
' ACTION:  cursor at end of each  & _  line  ←  then [Enter]
' EXPECTED: cursor at col 7  (column of the opening " in  stmt = "SELECT...)
' After "ORDER BY name"  ←  [Enter]  →  cursor at col 0  (stmt's indent)

stmt = "SELECT * FROM users " & _
       "WHERE status = 'active' " & _
       "ORDER BY name"

' ── C2. Long variable name ───────────────────────────────────────────────────
' ACTION:  cursor at end of each  & _  line  ←  then [Enter]
' EXPECTED: cursor at col 18  (column of the opening " in  anotherlongstmt = "SELECT...)
' After last line  ←  [Enter]  →  cursor at col 0

anotherlongstmt = "SELECT productCode " & _
                  "FROM [SampleDb].[dbo].[Products] " & _
                  "WHERE isActive = 1"

' ── C3. Assignment-head-only  (= _ pattern) ──────────────────────────────────
' ACTION:  cursor at end of "stmt = _"  ←  then [Enter]
' EXPECTED: cursor at col 4  (one indent level, no " column established yet)
' Then [Enter] after each  & _  line
' EXPECTED: cursor at col 4  (aligns to " of the first string line)
' After last line  ←  [Enter]  →  cursor at col 0

stmt = _
    "SELECT productCode " & _
    "FROM [SampleDb].[dbo].[Products] " & _
    "WHERE isActive = 1"

' ── C4. Blank line inside a continuation chain ───────────────────────────────
' ACTION:  cursor at end of "ORDER BY name"  ←  then [Enter]
' EXPECTED: cursor at col 0  (snaps back to stmt's indent despite the blank line)

stmt = "SELECT * FROM users " & _

       "ORDER BY name"

' ── C5. Continuation inside a function body ──────────────────────────────────
' ACTION:  cursor at end of each  & _  line  ←  then [Enter]
' EXPECTED: cursor at col 8  (column of the opening " on  q = "SELECT...)
' After " ORDER BY name"  ←  [Enter]  →  cursor at col 4  (q = ... line's indent)

Function BuildQuery(tableName)
    Dim q
    q = "SELECT * FROM " & tableName & _
        " WHERE isActive = 1 " & _
        " ORDER BY name"
    BuildQuery = q
End Function

%>


<!-- ══════════════════════════════════════════════════════════════════════════
     PART D  —  [Enter] at ASP tag boundaries
     ══════════════════════════════════════════════════════════════════════════ -->

<!-- D1. Expand an empty  <%  %>  block
     ACTION:  on the line below, place cursor between  <%  and  %>,  press [Enter]
     EXPECTED:
         <%
             (cursor here at col 0 — same level as the <%)
         %>                                                                    -->

<%  %>

<!-- D2. [Enter] after a standalone  <%
     ACTION:  cursor at end of the  <%  line inside the block below, press [Enter]
     EXPECTED: new line at col 0  (VBScript code level matches <% level)      -->

<%
Response.Write "hello"
%>

<!-- D3. [Enter] after a standalone  %>  inside a list
     ACTION:  cursor at end of the  %>  line inside the ul below, press [Enter]
     EXPECTED: new line at col 4  (inside the ul's child indent)              -->

<ul>
    <%
    For Each item In items
    %>
    <li><%= item %></li>
    <%
    Next
    %>
</ul>


<!-- ══════════════════════════════════════════════════════════════════════════
     PART E  —  [Tab] on blank lines
     ══════════════════════════════════════════════════════════════════════════ -->

<!-- E1. Tab after a block opener  →  jumps to col 4
     ACTION:  click on the blank line between "If condition Then" and
              "Response.Write" below, then press [Tab]
     EXPECTED: cursor jumps to col 4                                          -->

<%
If condition Then

    Response.Write "test"
End If
%>

<!-- E2. Tab after a regular statement  →  same level as line above
     ACTION:  click on the blank line between "Response.Write" and "End If"
              below, then press [Tab]
     EXPECTED: cursor jumps to col 4  (same as the line above it)            -->

<%
If condition Then
    Response.Write "test"

End If
%>

<!-- E3. Tab below a closer  →  same level as the closer
     ACTION:  click on the blank line below "End If", press [Tab]
     EXPECTED: cursor jumps to col 0                                          -->

<%
If condition Then
    Response.Write "test"
End If

%>

<!-- E4. Tab on a blank line immediately after  <%
     ACTION:  click on the blank line right after the  <%  below, press [Tab]
     EXPECTED: cursor at col 0  (no extra indent added for the <% line itself) -->

<%

Response.Write "test"
%>

<!-- E5. Tab below  %>  inside a div  →  div's child indent
     ACTION:  click on the blank line immediately after the  %>  inside the
              div below, then press [Tab]
     EXPECTED: cursor at col 4  (the div's child indent)                      -->

<div>
    <%
    Response.Write "test"
    %>

</div>


<!-- ══════════════════════════════════════════════════════════════════════════
     PART F  —  HTML [Enter] block expansion
     ══════════════════════════════════════════════════════════════════════════ -->

<!-- F1. [Enter] between opening and closing tag on the same line
     ACTION:  place cursor between  <div>  and  </div>  below, press [Enter]
     EXPECTED:
         <div>
             (cursor here at col 4)
         </div>                                                                -->

<div></div>

<!-- F2. [Enter] after an opening tag  (closing tag on the next line)
     ACTION:  cursor at end of the  <ul>  line below, press [Enter]
     EXPECTED: new line at col 4, cursor inside the block                     -->

<ul>
    <li>item</li>
</ul>

<!-- F3. [Enter] after a tag with NO closing tag yet
     ACTION:  at the very bottom of the file type  <section>  then [Enter]
     EXPECTED:
         <section>
             (cursor here at col 4)
         </section>  (auto-inserted by the extension)                         -->

<!-- F4. Self-closing tags — [Enter] must NOT produce a closing tag
     ACTION:  cursor at end of each tag below, press [Enter]
     EXPECTED: plain new line at col 0, no  </br>  </hr>  </input>           -->

<br>
<hr>
<input type="text">

<!-- F5. HTML comment auto-close
     ACTION:  type  <!-  and then type the fourth  -
     EXPECTED: the comment closes automatically  so you get  <!-- | -->       -->
