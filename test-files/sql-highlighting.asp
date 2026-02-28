<%
' ============================================================
' sql-highlighting.asp
' Test file for SQL semantic token colouring
' ============================================================


' ─────────────────────────────────────────────────────────────
' SECTION 1 — Regular strings (must NOT be coloured as SQL)
' These have SELECT or FROM alone but not both — no colouring.
' ─────────────────────────────────────────────────────────────

Dim msg1, msg2, msg3, msg4

msg1 = "Select an option from the list"          ' has SELECT-like word + FROM — but lowercase intent, should NOT trigger
msg2 = "Please select your country"              ' no clause keyword — not SQL
msg3 = "Error: could not connect to database"    ' plain string — not SQL
msg4 = "FROM the results, pick one"              ' has FROM but no verb — not SQL


' ─────────────────────────────────────────────────────────────
' SECTION 2 — Confirmed SQL strings (MUST be fully coloured)
' Each tests a different set of keywords and patterns.
' ─────────────────────────────────────────────────────────────

Dim stmt, sql, strQuery

' — Basic SELECT with WHERE, comparison, number literal, @param —
stmt = "SELECT TOP 10 u.UserId, u.Name, u.Email FROM dbo.Users u WHERE u.IsActive = 1 AND u.RoleId = @roleId ORDER BY u.Name ASC"

' — [bracketed] dot-chain: all three parts + bare alias should be table colour —
stmt = "SELECT a.DefectCode, a.DefectDesc FROM [ProductionDb].[dbo].[QCDefCode] a WITH (NOLOCK) WHERE a.Cmpy = 'TEST'"

' — JOIN variants: INNER, LEFT, RIGHT + ON + alias.column —
stmt = "SELECT o.OrderId, o.Total, u.Name, p.ProductName " & _
       "FROM dbo.Orders o " & _
       "INNER JOIN dbo.Users u ON u.UserId = o.UserId " & _
       "LEFT JOIN dbo.Products p ON p.ProductId = o.ProductId " & _
       "RIGHT JOIN dbo.Categories c ON c.CategoryId = p.CategoryId " & _
       "WHERE o.Total > 100 AND o.Status IN (1, 2, 3)"

' — INSERT INTO with VALUES and @params —
sql = "INSERT INTO dbo.AuditLog (UserId, Action, CreatedAt) VALUES (@userId, @action, GETDATE())"

' — UPDATE with SET, WHERE, IS NULL, IS NOT NULL —
sql = "UPDATE dbo.Users SET LastLogin = GETDATE(), FailedAttempts = 0 WHERE UserId = @userId AND DeletedAt IS NULL"

' — DELETE FROM with EXISTS subquery —
sql = "DELETE FROM dbo.TempSessions WHERE NOT EXISTS (SELECT 1 FROM dbo.Users u WHERE u.SessionId = TempSessions.SessionId)"

' — DDL: CREATE TABLE with data types —
sql = "CREATE TABLE dbo.ErrorLog (Id INT IDENTITY(1,1) PRIMARY KEY, Message NVARCHAR(500) NOT NULL, CreatedAt DATETIME2 DEFAULT GETDATE(), Severity TINYINT, IsResolved BIT DEFAULT 0)"

' — DDL: ALTER TABLE, DROP TABLE —
sql = "ALTER TABLE dbo.Users ADD LastLoginIp VARCHAR(45) NULL"
sql = "DROP TABLE IF EXISTS dbo.TempImport"

' — TRUNCATE TABLE —
sql = "TRUNCATE TABLE dbo.StagingData"

' — CREATE TEMP TABLE —
sql = "CREATE TABLE #TempResults (RowId INT, Value NVARCHAR(255), Score DECIMAL(10,2))"

' — Aggregate functions: COUNT, SUM, AVG, MAX, MIN —
sql = "SELECT COUNT(*) AS TotalOrders, SUM(o.Total) AS Revenue, AVG(o.Total) AS AvgOrder, MAX(o.Total) AS MaxOrder, MIN(o.Total) AS MinOrder FROM dbo.Orders o WHERE o.CreatedAt >= DATEADD(MONTH, -1, GETDATE())"

' — Window functions: ROW_NUMBER, RANK, DENSE_RANK, PARTITION BY, OVER —
sql = "SELECT UserId, Score, ROW_NUMBER() OVER (PARTITION BY Department ORDER BY Score DESC) AS RowNum, RANK() OVER (PARTITION BY Department ORDER BY Score DESC) AS Rnk, DENSE_RANK() OVER (PARTITION BY Department ORDER BY Score DESC) AS DenseRnk FROM dbo.Scores"

' — String functions: ISNULL, COALESCE, LEN, UPPER, LOWER, TRIM, REPLACE, SUBSTRING —
sql = "SELECT ISNULL(u.Nickname, u.Name) AS DisplayName, COALESCE(u.Phone, u.Mobile, 'N/A') AS Contact, LEN(u.Email) AS EmailLen, UPPER(u.Country) AS Country, REPLACE(LOWER(u.Email), '@', '[at]') AS SafeEmail, SUBSTRING(u.Name, 1, 50) AS ShortName FROM dbo.Users u"

' — Date functions: GETDATE, DATEADD, DATEDIFF, DATEPART, CONVERT, CAST, FORMAT —
sql = "SELECT GETDATE() AS Now, DATEADD(DAY, 30, GETDATE()) AS Expiry, DATEDIFF(DAY, u.CreatedAt, GETDATE()) AS DaysSinceJoin, DATEPART(YEAR, u.CreatedAt) AS JoinYear, CONVERT(VARCHAR(10), GETDATE(), 120) AS Today, CAST(o.Total AS INT) AS RoundedTotal, FORMAT(GETDATE(), 'yyyy-MM-dd') AS Formatted FROM dbo.Users u JOIN dbo.Orders o ON o.UserId = u.UserId"

' — CASE WHEN THEN ELSE END —
sql = "SELECT UserId, CASE WHEN Score >= 90 THEN 'A' WHEN Score >= 75 THEN 'B' WHEN Score >= 60 THEN 'C' ELSE 'F' END AS Grade, CASE IsActive WHEN 1 THEN 'Active' ELSE 'Inactive' END AS Status FROM dbo.Scores"

' — UNION ALL —
sql = "SELECT UserId, 'Admin' AS Role FROM dbo.Admins WHERE IsActive = 1 UNION ALL SELECT UserId, 'User' AS Role FROM dbo.Users WHERE IsActive = 1 UNION ALL SELECT UserId, 'Guest' AS Role FROM dbo.Guests WHERE ExpiresAt > GETDATE()"

' — GROUP BY, HAVING, DISTINCT —
sql = "SELECT DISTINCT u.Department, COUNT(u.UserId) AS HeadCount, AVG(u.Salary) AS AvgSalary FROM dbo.Users u WHERE u.IsActive = 1 GROUP BY u.Department HAVING COUNT(u.UserId) > 5 ORDER BY HeadCount DESC"

' — DECLARE, BEGIN TRAN, COMMIT, ROLLBACK —
sql = "DECLARE @total INT; SELECT @total = COUNT(*) FROM dbo.Orders WHERE CreatedAt >= GETDATE()"

' — EXEC stored procedure —
sql = "EXEC dbo.usp_ProcessOrders @batchSize = 100, @userId = @currentUser"

' — Logical: BETWEEN, LIKE, IN, NOT IN, EXISTS, ANY, ALL —
sql = "SELECT * FROM dbo.Products p WHERE p.Price BETWEEN 10 AND 500 AND p.Name LIKE 'Widget%' AND p.CategoryId IN (1, 2, 3) AND p.SupplierId NOT IN (SELECT SupplierId FROM dbo.BlacklistedSuppliers) AND EXISTS (SELECT 1 FROM dbo.Stock s WHERE s.ProductId = p.ProductId AND s.Qty > 0)"

' — NULL handling: IS NULL, IS NOT NULL, NULLIF, COALESCE —
sql = "SELECT UserId, NULLIF(u.Score, 0) AS Score, COALESCE(u.AltEmail, u.Email) AS ContactEmail FROM dbo.Users u WHERE u.DeletedAt IS NULL AND u.ManagerId IS NOT NULL"

' — CTE with WITH (must NOT colour CTE name as table) —
sql = "WITH RecentOrders AS (SELECT UserId, COUNT(*) AS OrderCount FROM dbo.Orders WHERE CreatedAt >= DATEADD(MONTH, -3, GETDATE()) GROUP BY UserId) SELECT u.Name, r.OrderCount FROM dbo.Users u JOIN RecentOrders r ON r.UserId = u.UserId ORDER BY r.OrderCount DESC"

' — Mixed [brackets] and bare names in same query —
sql = "SELECT u.Name, [Value#], Score FROM [ProductionDb].[dbo].[Users] u INNER JOIN dbo.Scores s ON s.UserId = u.UserId WHERE u.Cmpy = 'ACME'"


' ─────────────────────────────────────────────────────────────
' SECTION 3 — Variable concatenation (stmt appends)
' All fragments appended to a SQL variable must be coloured.
' ─────────────────────────────────────────────────────────────

Dim filters

stmt = "SELECT DefectCode, DefectDesc FROM [ProductionDb].[dbo].[QCDefCode] WITH (NOLOCK) WHERE Cmpy = '" & cmpy & "' AND ("

Dim prefixArray
prefixArray = Split(defectPrefix, ",")
For i = 0 To UBound(prefixArray)
    If i > 0 Then
        stmt = stmt & " OR "
    End If
    stmt = stmt & "DefectCode LIKE '" & Trim(prefixArray(i)) & "%'"
Next

stmt = stmt & ") ORDER BY DefectCode"


' ─────────────────────────────────────────────────────────────
' SECTION 4 — Multi-line & _ continuation stitching
' SQL split across lines with variable gaps must be fully coloured.
' ─────────────────────────────────────────────────────────────

strQuery = "SELECT o.OrderId, o.Total, u.Name " & _
           "FROM dbo.Orders o " & _
           "INNER JOIN dbo.Users u ON u.UserId = o.UserId " & _
           "WHERE o.Cmpy = '" & cmpy & "' " & _
           "AND o.Status = '" & status & "' " & _
           "AND o.Total > " & minTotal & " " & _
           "ORDER BY o.CreatedAt DESC"


' ─────────────────────────────────────────────────────────────
' SECTION 5 — Orange squiggly warning test
' stmt is already a SQL variable — this reassignment to a plain
' string should show a warning squiggly under "stmt".
' ─────────────────────────────────────────────────────────────

stmt = "Something went wrong, please select again."   ' <-- should show warning squiggly


' ─────────────────────────────────────────────────────────────
' SECTION 6 — Edge cases
' ─────────────────────────────────────────────────────────────

' Empty string — not SQL
Dim empty
empty = ""

' String with just a number — not SQL
Dim numStr
numStr = "12345"

' Looks like SQL verb only — no clause, must NOT colour
Dim notSql1, notSql2
notSql1 = "SELECT is not a valid response here"
notSql2 = "Please execute the plan as discussed"

' Nested quotes inside SQL (escaped "")
sql = "SELECT u.Name FROM dbo.Users u WHERE u.Tag = ""special"" AND u.IsActive = 1"

' @params throughout — all should be coloured as sql variable colour
sql = "UPDATE dbo.Settings SET Value = @value, UpdatedBy = @userId, UpdatedAt = GETDATE() WHERE SettingKey = @key AND Scope = @scope"

' Numeric literals throughout — all should get number colour
sql = "SELECT * FROM dbo.Tiers WHERE MinScore >= 0 AND MaxScore <= 100 AND TierId IN (1, 2, 3) AND Multiplier BETWEEN 1.5 AND 3.14"

' Deep dot-chain with mixed brackets and bare names
sql = "SELECT a.Name, b.Value, c.Code FROM [MyDb].[dbo].Orders a JOIN dbo.[Product List] b ON b.OrderId = a.OrderId JOIN dbo.Categories c ON c.Id = b.CategoryId"

%>