<%
' test-structure-diagnostics.asp — Structure diagnostics test (VBScript + HTML)
'
' HOW TO USE:
'   Open this file in VS Code with the Classic ASP extension active.
'   Wait ~1.5 s for the debounce to fire, then check the Problems panel.
'   Each section states exactly which lines SHOULD warn and which MUST NOT.
'
' LEGEND:
'   ' ← WARN   this opener or closer will have an orange squiggle
'   ' ← OK     no warning expected on this line

' ══════════════════════════════════════════════════════════════════════════════
' SECTION 1 — Happy path: every VBScript block correctly matched
'             EXPECTED: zero warnings in this entire section
' ══════════════════════════════════════════════════════════════════════════════

' ── 1a. If / ElseIf / Else / End If ─────────────────────────────────────────

If score >= 90 Then      ' ← OK
    grade = "A"
ElseIf score >= 75 Then
    grade = "B"
Else
    grade = "C"
End If                   ' ← OK

' ── 1b. Nested If ────────────────────────────────────────────────────────────

If userAge >= 18 Then    ' ← OK
    If score > 0 Then    ' ← OK
        result = "pass"
    End If               ' ← OK
End If                   ' ← OK

' ── 1c. For / Next ───────────────────────────────────────────────────────────

For i = 1 To 10          ' ← OK
    total = total + i
Next                     ' ← OK

' ── 1d. For Each / Next ──────────────────────────────────────────────────────

For Each item In itemList  ' ← OK
    Response.Write item & "<br>"
Next                       ' ← OK

' ── 1e. While / Wend ─────────────────────────────────────────────────────────

While attempts < 5       ' ← OK
    attempts = attempts + 1
Wend                     ' ← OK

' ── 1f. Do While / Loop ──────────────────────────────────────────────────────

Do While Not rs.EOF      ' ← OK
    Response.Write rs("Name") & "<br>"
    rs.MoveNext
Loop                     ' ← OK

' ── 1g. Do / Loop Until (post-condition) ─────────────────────────────────────

Do                       ' ← OK
    cursor = cursor + 1
Loop Until cursor >= 10  ' ← OK  (Loop closes Do — the Until is a condition, not an opener)

' ── 1h. Do / Loop While (post-condition) ─────────────────────────────────────

Do                       ' ← OK
    cursor = cursor - 1
Loop While cursor > 0    ' ← OK  (Loop closes Do — the While here is NOT a new While block)

' ── 1i. Select Case / End Select ─────────────────────────────────────────────

Select Case status       ' ← OK
    Case "active"
        label = "Active"
    Case "pending"
        label = "Pending"
    Case Else
        label = "Unknown"
End Select               ' ← OK

' ── 1j. Function / End Function ──────────────────────────────────────────────

Function CalculateTotal(qty, price)   ' ← OK
    Dim total
    total = qty * price
    If total < 0 Then
        total = 0
    End If
    CalculateTotal = total
End Function                          ' ← OK

' ── 1k. Sub / End Sub ────────────────────────────────────────────────────────

Sub LogMessage(msg)      ' ← OK
    Response.Write "[LOG] " & msg & "<br>"
End Sub                  ' ← OK

' ── 1l. With / End With ──────────────────────────────────────────────────────

With rs                  ' ← OK
    .Open stmt, conn
    Do While Not .EOF
        Response.Write .Fields("Name") & "<br>"
        .MoveNext
    Loop
    .Close
End With                 ' ← OK

' ── 1m. Class / End Class ────────────────────────────────────────────────────

Class UserModel          ' ← OK
    Private mName, mAge

    Public Property Get Name
        Name = mName
    End Property

    Public Property Let Name(val)
        mName = val
    End Property

    Public Function IsAdult()
        IsAdult = (mAge >= 18)
    End Function
End Class                ' ← OK

%>


<%
' ══════════════════════════════════════════════════════════════════════════════
' SECTION 2 — Unclosed VBScript openers
' ══════════════════════════════════════════════════════════════════════════════

' ── 2a. If with no End If ────────────────────────────────────────────────────

If showResults Then      ' ← WARN: Missing 'End If'
    Response.Write "Results"

' ── 2b. For with no Next ─────────────────────────────────────────────────────

For i = 1 To 5           ' ← WARN: Missing 'Next'
    total = total + i

' ── 2c. While with no Wend ───────────────────────────────────────────────────

While x < 10             ' ← WARN: Missing 'Wend'
    x = x + 1

' ── 2d. Do with no Loop ──────────────────────────────────────────────────────

Do While Not rs.EOF      ' ← WARN: Missing 'Loop'
    Response.Write rs("Name") & "<br>"
    rs.MoveNext

' ── 2e. Function with no End Function ────────────────────────────────────────

Function BuildLabel(param)   ' ← WARN: Missing 'End Function'
    BuildLabel = "Label: " & param

' ── 2f. Sub with no End Sub ──────────────────────────────────────────────────

Sub ResetCounters()      ' ← WARN: Missing 'End Sub'
    total = 0
    attempts = 0

' ── 2g. Select Case with no End Select ───────────────────────────────────────

Select Case grade        ' ← WARN: Missing 'End Select'
    Case "A"
        label = "Excellent"
    Case Else
        label = "Other"

' ── 2h. With with no End With ────────────────────────────────────────────────

With conn                ' ← WARN: Missing 'End With'
    .Open "DSN=TestDB"

' ── 2i. Class with no End Class ──────────────────────────────────────────────

Class OrderModel         ' ← WARN: Missing 'End Class'
    Private mId

%>


<%
' ══════════════════════════════════════════════════════════════════════════════
' SECTION 3 — Stray VBScript closers (no matching opener in this block)
' ══════════════════════════════════════════════════════════════════════════════

' ── 3a. Stray End If ─────────────────────────────────────────────────────────

Response.Write "no If above"
End If                   ' ← WARN: Unexpected 'End If' — no matching opener

' ── 3b. Stray Next ───────────────────────────────────────────────────────────

Response.Write "no For above"
Next                     ' ← WARN: Unexpected 'Next' — no matching opener

' ── 3c. Stray Wend ───────────────────────────────────────────────────────────

Response.Write "no While above"
Wend                     ' ← WARN: Unexpected 'Wend' — no matching opener

' ── 3d. Stray Loop ───────────────────────────────────────────────────────────

Response.Write "no Do above"
Loop                     ' ← WARN: Unexpected 'Loop' — no matching opener

' ── 3e. Stray End Function ───────────────────────────────────────────────────

Response.Write "no Function above"
End Function             ' ← WARN: Unexpected 'End Function' — no matching opener

' ── 3f. Stray End Sub ────────────────────────────────────────────────────────

Response.Write "no Sub above"
End Sub                  ' ← WARN: Unexpected 'End Sub' — no matching opener

%>


<%
' ══════════════════════════════════════════════════════════════════════════════
' SECTION 4 — Edge cases: things that MUST NOT trigger warnings
' ══════════════════════════════════════════════════════════════════════════════

' ── 4a. Single-line If (no End If needed) ────────────────────────────────────

If isActive Then Response.Write "Active"           ' ← OK: inline If, no End If
If IsNull(val) Then val = ""                       ' ← OK
If Not isReady Then Exit Sub                       ' ← OK

' ── 4b. On Error Resume Next — must NOT consume "Next" as a For closer ───────

On Error Resume Next     ' ← OK: the word "Next" here is not a For/Next closer
Dim conn2
Set conn2 = Server.CreateObject("ADODB.Connection")
conn2.Open "DSN=TestDB"
If Err.Number <> 0 Then
    errorMessage = Err.Description
    Err.Clear
End If
On Error Goto 0

' A real For/Next immediately after — the scanner must not have consumed "Next"

For i = 1 To 3           ' ← OK
    Response.Write i & "<br>"
Next                     ' ← OK

' ── 4c. Keywords inside VBScript comment lines — must be invisible ────────────
'
' The lines below contain If, For, While, Function, End If etc. but they are
' all on comment lines.  The scanner skips entire comment lines so none of
' these should affect the stack at all.
'
' If this breaks then the comment line:
' For i = 1 To 10
'     total = total + i
' Next
' While x < 10
'     x = x + 1
' Wend
' Function FakeFunc()
'     FakeFunc = 1
' End Function
' End If  ← stray closer if scanner reads comments

' ── 4d. Keywords inside string literals — must be invisible ──────────────────

Dim msg1, msg2, msg3, msg4, msg5
msg1 = "If you need help, please call support"      ' ← OK: "If" is in a string
msg2 = "End If the issue persists, escalate"        ' ← OK: "End If" is in a string
msg3 = "For each item please review the attached"   ' ← OK
msg4 = "Next steps: submit the form"                ' ← OK: "Next" in a string
msg5 = "While we investigate, avoid rebooting"      ' ← OK: "While" in a string

' ── 4e. Do While — must be classified as Do (closer: Loop), not While (closer: Wend)

Do While Not rs.EOF      ' ← OK: this is a Do block, not a While block
    rs.MoveNext
Loop                     ' ← OK: Loop closes the Do, not a Wend

' ── 4f. Loop While (post-condition) — "While" after Loop must NOT open a new While block

Do                       ' ← OK
    cursor = cursor + 1
Loop While cursor < 20   ' ← OK: Loop closes the Do; the "While" is a condition

' ── 4g. ElseIf / Else — must not open or close an If block ───────────────────

If score >= 90 Then      ' ← OK
    grade = "A"
ElseIf score >= 75 Then  ' ← OK: not an opener or a closer
    grade = "B"
Else                     ' ← OK: not an opener or a closer
    grade = "C"
End If                   ' ← OK

' ── 4h. REM comment lines — keywords inside must be invisible ─────────────────

Rem If this fires it is a bug
Rem For i = 1 To 100
Rem Next
Rem End If

' ── 4i. Escaped double-quote inside string — scanner must not fall out of string

Dim escaped
escaped = "He said ""End If"" and walked out"   ' ← OK: End If is inside a string with escaped quotes

' ── 4j. With keyword inside a string — must not open a With block ─────────────

Dim hint
hint = "With great power comes great responsibility"   ' ← OK: "With" is in a string

%>


<%
' ══════════════════════════════════════════════════════════════════════════════
' SECTION 5 — Mismatched / wrong-order VBScript closers
' ══════════════════════════════════════════════════════════════════════════════

' ── 5a. If closed by wrong keyword (Next instead of End If) ──────────────────
If condition Then        ' ← WARN: unclosed — no End If in this block
    Response.Write "oops"
Next                     ' ← WARN: Unexpected 'Next' — no For above this

' ── 5b. Nested blocks — inner closed, outer not ──────────────────────────────
For i = 1 To 5           ' ← WARN: Missing 'Next' — never closed
    If items(i) <> "" Then  ' ← OK: this If is correctly closed below
        Response.Write items(i) & "<br>"
    End If               ' ← OK: closes the If above

' ── 5c. Swapped End Sub / End Function ───────────────────────────────────────
Function GetName()       ' ← OK: matched by End Function below via stack walk-back
    GetName = "Alice"
End Sub                  ' ← WARN: Unexpected 'End Sub' — no Sub above this

Sub PrintName()          ' ← WARN: unclosed — popped when End Function matches Function above
    Response.Write "Bob"
End Function             ' ← OK: matches Function GetName via stack walk-back

%>


<%
' ══════════════════════════════════════════════════════════════════════════════
' SECTION 6 — Keywords outside ASP blocks must be completely ignored
' ══════════════════════════════════════════════════════════════════════════════

%>

<!-- The words below appear in raw HTML — the ASP scanner must ignore them entirely -->
<p>If you select the correct option, the For loop will run until the Next step.</p>
<p>While this is processing, please wait. Wend your way to the results page.</p>
<p>Do not refresh the page. Loop back here after submitting.</p>
<p>End If you have questions, contact support. End Sub-missions at midnight.</p>

<%


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 7 — Deeply nested real-world block (all correctly matched)
' ══════════════════════════════════════════════════════════════════════════════

Function ProcessBatch(items)       ' ← OK
    Dim i, item, result

    For Each item In items         ' ← OK
        If IsNull(item) Then       ' ← OK
            item = ""
        ElseIf item = "skip" Then
            ' do nothing
        Else
            Select Case item       ' ← OK
                Case "A"
                    countA = countA + 1
                Case "B"
                    countB = countB + 1
                Case Else
                    other = other + 1
            End Select             ' ← OK
        End If                     ' ← OK
    Next                           ' ← OK

    ProcessBatch = countA + countB
End Function                       ' ← OK

%>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 8 — Happy path: HTML structural tags correctly matched
     ═══════════════════════════════════════════════════════════════════════════ -->

<div class="container">
    <header>
        <nav>
            <ul>
                <li><a href="index.asp">Home</a></li>
                <li><a href="products.asp">Products</a></li>
            </ul>
        </nav>
    </header>

    <main>
        <section class="results">
            <form action="search.asp" method="post">
                <fieldset>
                    <select name="category">
                        <option value="">All</option>
                        <option value="1">Category A</option>
                    </select>
                </fieldset>
            </form>

            <table>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Status</th>
                        <th>Total</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>Alice</td>
                        <td>Active</td>
                        <td>150</td>
                    </tr>
                    <tr>
                        <td>Bob</td>
                        <td>Inactive</td>
                        <td>80</td>
                    </tr>
                </tbody>
                <tfoot>
                    <tr>
                        <td colspan="2">Total</td>
                        <td>230</td>
                    </tr>
                </tfoot>
            </table>
        </section>

        <aside>
            <figure>
                <figcaption>Chart placeholder</figcaption>
            </figure>
        </aside>
    </main>

    <footer>
        <p>&copy; 2025 Classic ASP Extension Test</p>
    </footer>
</div>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 9 — Unclosed HTML structural tags
     ═══════════════════════════════════════════════════════════════════════════ -->

<!-- 9a. div with no closing tag -->
<div class="panel">      <!-- ← WARN: Missing </div> -->
    <p>Content here</p>

<!-- 9b. table with no closing tag (thead/tbody/tr are correctly matched inside) -->
<table>                  <!-- ← WARN: Missing </table> -->
    <thead>
        <tr>
            <th>Name</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>Alice</td>
        </tr>
    </tbody>

<!-- 9c. form with no closing tag -->
<form action="save.asp" method="post">  <!-- ← WARN: Missing </form> -->
    <input type="text" name="username">

<!-- 9d. ul with no closing tag -->
<ul>                     <!-- ← WARN: Missing </ul> -->
    <li>Item one</li>
    <li>Item two</li>

<!-- 9e. nav with no closing tag -->
<nav>                    <!-- ← WARN: Missing </nav> -->
    <a href="index.asp">Home</a>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 10 — Stray HTML closing tags
     ═══════════════════════════════════════════════════════════════════════════ -->

<!-- 10a. </div> matches <div class="panel"> from section 9.
          Everything above it on the stack (nav, ul, form, table) is popped
          as unclosed — warnings fire on those section 9 openers, not here. -->
</div>                   <!-- ← OK as a closer (matches section 9 div) -->

<!-- 10b. Stray </table> — stack is empty after 10a -->
<p>Stack is now empty</p>
</table>                 <!-- ← WARN: Unexpected </table> — no opening <table> left -->

<!-- 10c. Stray </section> -->
<p>No section above this</p>
</section>               <!-- ← WARN: Unexpected </section> — no opening <section> -->

<!-- 10d. Stray </form> -->
<p>No form above this</p>
</form>                  <!-- ← WARN: Unexpected </form> — no opening <form> left -->


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 11 — HTML edge cases that MUST NOT trigger warnings
     ═══════════════════════════════════════════════════════════════════════════ -->

<!-- 11a. Self-closing tags — must not be pushed onto the stack -->
<input type="text" name="username">
<input type="hidden" name="token" value="abc123">
<br>
<hr>
<img src="logo.png" alt="Logo">
<link rel="stylesheet" href="style.css">
<meta charset="UTF-8">

<!-- 11b. Explicit self-closing syntax -->
<input type="checkbox" name="agree" />

<!-- 11c. Tags inside HTML comments — must be invisible to the scanner -->
<!--
<div class="hidden-in-comment">
    <table>
        <tr><td>This div and table are inside a comment</td></tr>
    </table>
</div>
-->

<!-- 11d. Non-structural tags — span, p, a, label etc. are not checked -->
<p>
    <span class="highlight">Highlighted</span> text with
    <a href="detail.asp">a link</a> and a
    <label for="field">label</label>.
</p>

<!-- 11e. Tags inside <script> and <style> blocks — must be invisible -->
<script>
    // These tags inside JS must not affect the HTML stack
    var template = '<div class="card"><table><tr><td>JS string</td></tr></table></div>';
    var open = '<div>';
    var close = '</div>';
</script>

<style>
    /* div, table, form etc. in CSS selectors must not affect the HTML stack */
    div.container { display: flex; }
    table { border-collapse: collapse; }
    form > fieldset { border: 1px solid #ccc; }
</style>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 12 — HTML tags inside ASP blocks — must be ignored by HTML scanner
     ═══════════════════════════════════════════════════════════════════════════ -->

<%
    ' These Response.Write calls contain structural HTML tag strings but they
    ' are inside ASP blocks so the HTML scanner must skip them entirely.
    Response.Write "<div class=""dynamic"">"
    Response.Write "<table>"
    Response.Write "<tr><td>Row</td></tr>"
    Response.Write "</table>"
    Response.Write "</div>"

    ' A real correctly-matched ASP-wrapped HTML block follows
%>

<div class="wrapper">
    <%
    For Each item In itemList
    %>
    <div class="item">
        <p><%= item %></p>
    </div>
    <%
    Next
    %>
</div>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 13 — HTML tags with inline ASP expressions in attributes
                  <%= ... %> or <% ... %> inside attribute values
     ═══════════════════════════════════════════════════════════════════════════ -->

<div class="row" id="row-<%= rowId %>">
    <table border="0" width="<%= tableWidth %>%">
        <tr class="<%= rowClass %>">
            <td align="<%= cellAlign %>"><%= cellValue %></td>
        </tr>
    </table>
</div>

<form action="<%= formAction %>" method="post" enctype="<%= encType %>">
    <select name="status" onchange="<% Response.Write jsHandler %>">
        <option value="1">Active</option>
    </select>
</form>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 14 — Mixed unclosed HTML + ASP in a real-world-style page fragment
     ═══════════════════════════════════════════════════════════════════════════ -->

<div class="search-results">    <!-- ← WARN: Missing </div> — never closed below -->

    <table class="data-grid">   <!-- ← WARN: Missing </table> — never closed below -->
        <thead>
            <tr>
                <th>Product</th>
                <th>Qty</th>
            </tr>
        </thead>
        <tbody>

<%
    Dim stmt, rs2
    stmt = "SELECT ProductCode, StockQty FROM [SampleDb].[dbo].[Products] WHERE IsActive = 1"
    Set rs2 = conn.Execute(stmt)

    Do While Not rs2.EOF        ' ← OK: correctly closed below
%>
            <tr>
                <td><%= rs2("ProductCode") %></td>
                <td><%= rs2("StockQty") %></td>
            </tr>
<%
        rs2.MoveNext
    Loop                        ' ← OK
    rs2.Close
    Set rs2 = Nothing
%>

        </tbody>
    <!-- intentionally missing </table> and </div> to trigger warnings above -->
