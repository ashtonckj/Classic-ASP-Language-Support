<%
' test-formatting.asp — Formatter test (Shift+Alt+F)
'
' HOW TO USE:
'   Each test shows the BEFORE state in a comment above the live code.
'   Press Shift+Alt+F to format, then compare against the comment.
'   Press Ctrl+Z to undo and return to the before state.
'
' WHAT SHOULD CHANGE:  keyword casing, operator spacing, indentation,
'                      comma spacing, asp tag placement.
' WHAT MUST NOT CHANGE: content inside string literals.


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 1 — Keyword casing
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: all lowercase keywords
' dim username,userage,isactive
' if userage>=18 then
' response.write "Adult"
' else
' response.write "Minor"
' end if

dim username,userage,isactive
if userage>=18 then
response.write "Adult"
else
response.write "Minor"
end if

' BEFORE: all uppercase keywords
' DIM SCORE,MAXSCORE
' FOR I=1 TO 10
' SCORE=SCORE+I
' NEXT
' WHILE SCORE>100
' SCORE=SCORE-10
' WEND

DIM SCORE,MAXSCORE
FOR I=1 TO 10
SCORE=SCORE+I
NEXT
WHILE SCORE>100
SCORE=SCORE-10
WEND

' BEFORE: mixed random casing
' DiM firstName,lastName
' FuNcTiOn BuildName(first,last)
' BuildName=first&" "&last
' EnD fUnCtIoN
' sElEcT cAsE grade
' cAsE "A"
' label="Excellent"
' cAsE eLsE
' label="Other"
' EnD SeLeCt

DiM firstName,lastName
FuNcTiOn BuildName(first,last)
BuildName=first&" "&last
EnD fUnCtIoN
sElEcT cAsE grade
cAsE "A"
label="Excellent"
cAsE eLsE
label="Other"
EnD SeLeCt


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 2 — Operator spacing
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: no spaces around operators
' result=a+b-c*d/e
' isValid=(age>=18 and score<=100)
' name=firstName&" "&lastName
' isEqual=(x=y)
' notEqual=(x<>y)
' combined=(a<=b or c>=d)

result=a+b-c*d/e
isValid=(age>=18 and score<=100)
name=firstName&" "&lastName
isEqual=(x=y)
notEqual=(x<>y)
combined=(a<=b or c>=d)

' BEFORE: spaces missing from some sides only
' total =qty*price
' label= "Hello"
' check=x >0

total =qty*price
label= "Hello"
check=x >0

' EDGE CASE: unary minus and negative literals — MUST NOT gain spaces
' BEFORE: negativeVal = -1
'         result = -x
'         offset = x + -1
'         clamped = Abs(-score)
' EXPECTED: unchanged — unary minus is not a binary operator

negativeVal = -1
result = -x
offset = x + -1
clamped = Abs(-score)

' EDGE CASE: minus sign inside a string — MUST stay exactly as written
' BEFORE: dash = "-"
'         rootCause = "Root - Cause"
'         code = "ERR-404"
'         msg = "x-y=z"

dash = "-"
rootCause = "Root - Cause"
code = "ERR-404"
msg = "x-y=z"


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 3 — Comma spacing
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: no space after commas
' dim a,b,c,d
' call DoWork(a,b,c)
' arr = Array(1,2,3,4,5)
' result = Mid(str,2,4)

dim a,b,c,d
call DoWork(a,b,c)
arr = Array(1,2,3,4,5)
result = Mid(str,2,4)

' EDGE CASE: comma inside string — MUST stay unchanged
' BEFORE: csv = "one,two,three"
'         msg = "Hello, World"

csv = "one,two,three"
msg = "Hello, World"


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 4 — Indentation: If / ElseIf / Else / End If
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: completely flat (no indentation at all)
' if condition1 then
' response.write "yes"
' elseif condition2 then
' response.write "maybe"
' else
' response.write "no"
' end if

if condition1 then
response.write "yes"
elseif condition2 then
response.write "maybe"
else
response.write "no"
end if

' BEFORE: over-indented
' if condition1 then
'             response.write "yes"
'             elseif condition2 then
'                 response.write "maybe"
'             else
'                 response.write "no"
'             end if

if condition1 then
            response.write "yes"
            elseif condition2 then
                response.write "maybe"
            else
                response.write "no"
            end if

' BEFORE: nested If — both levels flat
' if outerCondition then
' if innerCondition then
' response.write "both true"
' end if
' end if

if outerCondition then
if innerCondition then
response.write "both true"
end if
end if


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 5 — Indentation: For / Next, While / Wend, Do / Loop
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE:
' for i=1 to 10
' total=total+i
' next
' for i=10 to 1 step -1
' countdown=countdown&i&" "
' next
' for each item in itemList
' response.write item
' next

for i=1 to 10
total=total+i
next
for i=10 to 1 step -1
countdown=countdown&i&" "
next
for each item in itemList
response.write item
next

' BEFORE:
' while x<10
' x=x+1
' wend
' do while not rs.EOF
' response.write rs("Name")
' rs.MoveNext
' loop
' do until cursor=10
' cursor=cursor+1
' loop

while x<10
x=x+1
wend
do while not rs.EOF
response.write rs("Name")
rs.MoveNext
loop
do until cursor=10
cursor=cursor+1
loop


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 6 — Indentation: Select Case
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: flat, no indentation
' select case status
' case "active"
' response.write "Active"
' case "pending"
' response.write "Pending"
' case else
' response.write "Unknown"
' end select

select case status
case "active"
response.write "Active"
case "pending"
response.write "Pending"
case else
response.write "Unknown"
end select

' BEFORE: nested Select Case inside a For loop, all flat
' for i=0 to ubound(items)
' select case items(i)
' case "A"
' scoreA=scoreA+1
' case "B"
' scoreB=scoreB+1
' end select
' next

for i=0 to ubound(items)
select case items(i)
case "A"
scoreA=scoreA+1
case "B"
scoreB=scoreB+1
end select
next


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 7 — Indentation: Function / Sub / With / Class
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: no indentation inside function or sub
' function CalculateTotal(qty,price)
' dim total
' total=qty*price
' if total<0 then
' total=0
' end if
' CalculateTotal=total
' end function

function CalculateTotal(qty,price)
dim total
total=qty*price
if total<0 then
total=0
end if
CalculateTotal=total
end function

' BEFORE: sub with exit sub
' sub ProcessItem(item)
' if item="" then
' exit sub
' end if
' response.write item
' end sub

sub ProcessItem(item)
if item="" then
exit sub
end if
response.write item
end sub

' BEFORE: With block flat
' with rs
' .Open stmt,conn
' do while not .EOF
' response.write .Fields("Name")
' .MoveNext
' loop
' .Close
' end with

with rs
.Open stmt,conn
do while not .EOF
response.write .Fields("Name")
.MoveNext
loop
.Close
end with

' BEFORE: Class definition flat
' class UserModel
' private mName,mAge
' public property get Name
' Name=mName
' end property
' public property let Name(val)
' mName=val
' end property
' public function IsAdult()
' IsAdult=(mAge>=18)
' end function
' end class

class UserModel
private mName,mAge
public property get Name
Name=mName
end property
public property let Name(val)
mName=val
end property
public function IsAdult()
IsAdult=(mAge>=18)
end function
end class


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 8 — Inline If (single-line — must stay on one line)
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: should stay on one line, just casing + spacing fixed
' if x=1 then y=2
' if isNull(val) then val=""
' if not isActive then exit sub

if x=1 then y=2
if isNull(val) then val=""
if not isActive then exit sub


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 9 — ASP tag placement
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: code crammed onto tag lines
' <$ dim x : x=1 $>  — this is a single-line block, valid
' <$if x=1 then$>    — code immediately after <% with no space
' <$response.write x$>

' (These are represented as live code below)
%>
<%dim rawVal : rawVal=42%>
<%if rawVal>0 then%>
<p>Positive</p>
<%end if%>

<%
' ══════════════════════════════════════════════════════════════════════════════
' SECTION 10 — String continuation alignment
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: continuation strings not aligned
' stmt = "SELECT * FROM users " & _
' "WHERE status='active' " & _
' "ORDER BY name"
'
' EXPECTED after format: each string aligns under the opening " of the first line
' stmt = "SELECT * FROM users " & _
'        "WHERE status='active' " & _
'        "ORDER BY name"

stmt = "SELECT * FROM users " & _
"WHERE status='active' " & _
"ORDER BY name"

' BEFORE: longer variable name shifts the alignment column
' anotherlongstmt = "SELECT productCode, productName " & _
' "FROM [SampleDb].[dbo].[Products] " & _
' "WHERE isActive = 1 " & _
' "ORDER BY productName"

anotherlongstmt = "SELECT productCode, productName " & _
"FROM [SampleDb].[dbo].[Products] " & _
"WHERE isActive = 1 " & _
"ORDER BY productName"

' BEFORE: assignment-head-only first line (= _ pattern)
' stmt = _
' "SELECT productCode " & _
' "FROM [SampleDb].[dbo].[Products] " & _
' "WHERE isActive = 1"

stmt = _
"SELECT productCode " & _
"FROM [SampleDb].[dbo].[Products] " & _
"WHERE isActive = 1"


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 11 — Comment indentation
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: comments at wrong indent levels
' if condition then
' ' this comment is at column 0 but should be at body indent
' response.write "yes"
' ' this one too
' end if

if condition then
' this comment is at column 0 but should be at body indent
response.write "yes"
' this one too
end if


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 12 — On Error / Err
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: keyword casing on On Error Resume Next / GoTo 0
' on error resume next
' dim conn
' set conn=server.createobject("ADODB.Connection")
' conn.Open "DSN=TestDB"
' if err.number<>0 then
' errMsg=err.description
' err.clear
' end if
' on error goto 0

on error resume next
dim conn
set conn=server.createobject("ADODB.Connection")
conn.Open "DSN=TestDB"
if err.number<>0 then
errMsg=err.description
err.clear
end if
on error goto 0


' ══════════════════════════════════════════════════════════════════════════════
' SECTION 13 — Deeply nested real-world block
' ══════════════════════════════════════════════════════════════════════════════

' BEFORE: everything flat, wrong casing, no spacing
' if showResults and validationError="" then
' stmt="SELECT th.Process, td.Cavity FROM [ProductionDb].[dbo].[FPY_hdr] th WHERE th.Cmpy='"&cmpy&"'"
' rs.Open stmt,conn
' if rs.EOF then
' response.write "No records."
' else
' while not rs.EOF
' processVal="-"
' if not isNull(rs("Process")) then processVal=rs("Process")
' response.write processVal
' rs.MoveNext
' wend
' end if
' rs.Close
' else
' response.write "Please search."
' end if

if showResults and validationError="" then
stmt="SELECT th.Process, td.Cavity FROM [ProductionDb].[dbo].[FPY_hdr] th WHERE th.Cmpy='"&cmpy&"'"
rs.Open stmt,conn
if rs.EOF then
response.write "No records."
else
while not rs.EOF
processVal="-"
if not isNull(rs("Process")) then processVal=rs("Process")
response.write processVal
rs.MoveNext
wend
end if
rs.Close
else
response.write "Please search."
end if

%>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 14 — HTML formatting (Prettier)
     ═══════════════════════════════════════════════════════════════════════════ -->

<!-- BEFORE: flat HTML, no indentation
<table>
<thead>
<tr>
<th>Name</th><th>Age</th><th>Status</th>
</tr>
</thead>
<tbody>
<tr>
<td>Alice</td><td>30</td><td>Active</td>
</tr>
</tbody>
</table>
-->

<table>
<thead>
<tr>
<th>Name</th><th>Age</th><th>Status</th>
</tr>
</thead>
<tbody>
<tr>
<td>Alice</td><td>30</td><td>Active</td>
</tr>
</tbody>
</table>

<!-- BEFORE: attributes on wrong lines
<input type="text" name="username" id="username" class="form-control" placeholder="Enter username" required>
-->

<input type="text" name="username" id="username" class="form-control" placeholder="Enter username" required>

<!-- BEFORE: inline elements (must respect whitespace sensitivity)
<p>Hello <strong>World</strong>, welcome to <em>Classic ASP</em>.</p>
-->

<p>Hello <strong>World</strong>, welcome to <em>Classic ASP</em>.</p>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 15 — Mixed HTML + ASP blocks
     ═══════════════════════════════════════════════════════════════════════════ -->

<!-- BEFORE: ASP blocks embedded in HTML, all flat
<ul>
<%
for each item in itemList
%>
<li><%= item %></li>
<%
next
%>
</ul>
-->

<ul>
<%
for each item in itemList
%>
<li><%= item %></li>
<%
next
%>
</ul>

<!-- BEFORE: ASP block spanning If/Else across HTML
<%if showBanner then%>
<div class="banner">Active</div>
<%else%>
<div class="banner">Inactive</div>
<%end if%>
-->

<%if showBanner then%>
<div class="banner">Active</div>
<%else%>
<div class="banner">Inactive</div>
<%end if%>

<!-- BEFORE: Inline ASP output in attributes — must not break attributes
<img src="<%= imagePath %>" alt="<%= imageAlt %>" class="thumb">
<a href="page.asp?id=<%= itemId %>&cat=<%= catId %>">Link</a>
-->

<img src="<%= imagePath %>" alt="<%= imageAlt %>" class="thumb">
<a href="page.asp?id=<%= itemId %>&cat=<%= catId %>">Link</a>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 16 — JavaScript formatting (Prettier)
     ═══════════════════════════════════════════════════════════════════════════ -->

<script>
// BEFORE: no spacing, inconsistent style
// function testFunc(a,b){let r=a+b;return r;}
// const arrow=(x,y)=>{return x*y;}
// if(x>0){console.log("positive");}else{console.log("negative");}

function testFunc(a,b){let r=a+b;return r;}
const arrow=(x,y)=>{return x*y;}
if(x>0){console.log("positive");}else{console.log("negative");}

// BEFORE: object and array literals with no spacing
// const config={host:"localhost",port:1433,database:"TestDB"}
// const ids=[1,2,3,4,5]

const config={host:"localhost",port:1433,database:"TestDB"}
const ids=[1,2,3,4,5]
</script>


<!-- ═══════════════════════════════════════════════════════════════════════════
     SECTION 17 — CSS formatting (Prettier)
     ═══════════════════════════════════════════════════════════════════════════ -->

<style>
/* BEFORE: no spacing, everything crammed
.container{display:flex;flex-direction:column;align-items:center;background-color:#f0f0f0;padding:20px 10px;margin:0 auto;}
.btn{color:red;background:blue;border:1px solid #ccc;border-radius:4px;padding:8px 16px;cursor:pointer;}
.btn:hover{opacity:0.8;}
*/

.container{display:flex;flex-direction:column;align-items:center;background-color:#f0f0f0;padding:20px 10px;margin:0 auto;}
.btn{color:red;background:blue;border:1px solid #ccc;border-radius:4px;padding:8px 16px;cursor:pointer;}
.btn:hover{opacity:0.8;}
</style>
