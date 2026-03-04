<%
' sql-highlighting.asp — SQL semantic token colouring test


' ── SECTION 1  Regular strings (must NOT colour as SQL) ──────────────────────

Dim msg1, msg2, msg3

msg1 = "Select an option from the list"       ' SELECT-like + FROM — not SQL
msg2 = "Error: could not connect to database" ' plain string
msg3 = "FROM the results, pick one"           ' FROM only — not SQL


' ── SECTION 2  Confirmed SQL strings (MUST be fully coloured) ────────────────

Dim stmt, sql, strQuery

' SELECT TOP, WHERE, @param, ORDER BY ASC
stmt = "SELECT TOP 10 u.UserId, u.Name, u.Email FROM dbo.Users u WHERE u.IsActive = 1 AND u.RoleId = @roleId ORDER BY u.Name ASC"

' [bracketed] dot-chain + bare alias + WITH (NOLOCK)
stmt = "SELECT a.ProductCode, a.ProductName FROM [SampleDb].[dbo].[Products] a WITH (NOLOCK) WHERE a.IsActive = 'Y'"

' INNER JOIN, LEFT JOIN, RIGHT JOIN + IN (...)
stmt = "SELECT o.OrderId, o.Total, u.Name, p.ProductName " & _
       "FROM dbo.Orders o " & _
       "INNER JOIN dbo.Users u ON u.UserId = o.UserId " & _
       "LEFT JOIN dbo.Products p ON p.ProductId = o.ProductId " & _
       "RIGHT JOIN dbo.Categories c ON c.CategoryId = p.CategoryId " & _
       "WHERE o.Total > 100 AND o.Status IN (1, 2, 3)"

' INSERT INTO ... VALUES
sql = "INSERT INTO dbo.AuditLog (UserId, Action, CreatedAt) VALUES (@userId, @action, GETDATE())"

' UPDATE ... SET, IS NULL
sql = "UPDATE dbo.Users SET LastLogin = GETDATE(), FailedAttempts = 0 WHERE UserId = @userId AND DeletedAt IS NULL"

' DELETE FROM + NOT EXISTS subquery
sql = "DELETE FROM dbo.TempSessions WHERE NOT EXISTS (SELECT 1 FROM dbo.Users u WHERE u.SessionId = TempSessions.SessionId)"

' CREATE TABLE with data types, IDENTITY, DEFAULT
sql = "CREATE TABLE dbo.ErrorLog (Id INT IDENTITY(1,1) PRIMARY KEY, Message NVARCHAR(500) NOT NULL, CreatedAt DATETIME2 DEFAULT GETDATE(), IsResolved BIT DEFAULT 0)"

' ALTER TABLE ... ADD, DROP TABLE IF EXISTS, TRUNCATE TABLE
sql = "ALTER TABLE dbo.Users ADD LastLoginIp VARCHAR(45) NULL"
sql = "DROP TABLE IF EXISTS dbo.TempImport"
sql = "TRUNCATE TABLE dbo.StagingData"

' Temp table
sql = "CREATE TABLE #TempResults (RowId INT, Value NVARCHAR(255), Score DECIMAL(10,2))"

' Aggregate functions: COUNT, SUM, AVG, MAX, MIN
sql = "SELECT COUNT(*) AS TotalOrders, SUM(o.Total) AS Revenue, AVG(o.Total) AS AvgOrder, MAX(o.Total) AS MaxOrder, MIN(o.Total) AS MinOrder FROM dbo.Orders o WHERE o.CreatedAt >= DATEADD(MONTH, -1, GETDATE())"

' Window functions: ROW_NUMBER, RANK, DENSE_RANK, OVER, PARTITION BY
sql = "SELECT UserId, Score, ROW_NUMBER() OVER (PARTITION BY Department ORDER BY Score DESC) AS RowNum, RANK() OVER (PARTITION BY Department ORDER BY Score DESC) AS Rnk, DENSE_RANK() OVER (PARTITION BY Department ORDER BY Score DESC) AS DenseRnk FROM dbo.Scores"

' String functions: ISNULL, COALESCE, LEN, UPPER, LOWER, REPLACE, SUBSTRING
sql = "SELECT ISNULL(u.Nickname, u.Name) AS DisplayName, COALESCE(u.Phone, u.Mobile, 'N/A') AS Contact, LEN(u.Email) AS EmailLen, UPPER(u.Country) AS Country, REPLACE(LOWER(u.Email), '@', '[at]') AS SafeEmail, SUBSTRING(u.Name, 1, 50) AS ShortName FROM dbo.Users u"

' Date functions: DATEADD, DATEDIFF, DATEPART, CONVERT, CAST, FORMAT
sql = "SELECT DATEADD(DAY, 30, GETDATE()) AS Expiry, DATEDIFF(DAY, u.CreatedAt, GETDATE()) AS DaysSince, DATEPART(YEAR, u.CreatedAt) AS JoinYear, CONVERT(VARCHAR(10), GETDATE(), 120) AS Today, CAST(o.Total AS INT) AS Rounded, FORMAT(GETDATE(), 'yyyy-MM-dd') AS Formatted FROM dbo.Users u JOIN dbo.Orders o ON o.UserId = u.UserId"

' CASE WHEN THEN ELSE END
sql = "SELECT UserId, CASE WHEN Score >= 90 THEN 'A' WHEN Score >= 75 THEN 'B' ELSE 'F' END AS Grade, CASE IsActive WHEN 1 THEN 'Active' ELSE 'Inactive' END AS Status FROM dbo.Scores"

' UNION ALL
sql = "SELECT UserId, 'Admin' AS Role FROM dbo.Admins WHERE IsActive = 1 UNION ALL SELECT UserId, 'User' AS Role FROM dbo.Users WHERE IsActive = 1"

' DISTINCT, GROUP BY, HAVING
sql = "SELECT DISTINCT u.Department, COUNT(u.UserId) AS HeadCount, AVG(u.Salary) AS AvgSalary FROM dbo.Users u WHERE u.IsActive = 1 GROUP BY u.Department HAVING COUNT(u.UserId) > 5 ORDER BY HeadCount DESC"

' DECLARE
sql = "DECLARE @total INT; SELECT @total = COUNT(*) FROM dbo.Orders WHERE CreatedAt >= GETDATE()"

' EXEC stored procedure
sql = "EXEC dbo.usp_ProcessOrders @batchSize = 100, @userId = @currentUser"

' BETWEEN, LIKE, NOT IN, EXISTS
sql = "SELECT * FROM dbo.Products p WHERE p.Price BETWEEN 10 AND 500 AND p.Name LIKE 'Widget%' AND p.CategoryId NOT IN (SELECT CategoryId FROM dbo.DisabledCategories) AND EXISTS (SELECT 1 FROM dbo.Stock s WHERE s.ProductId = p.ProductId AND s.Qty > 0)"

' IS NOT NULL, NULLIF, COALESCE (null handling group)
sql = "SELECT UserId, NULLIF(u.Score, 0) AS Score, COALESCE(u.AltEmail, u.Email) AS ContactEmail FROM dbo.Users u WHERE u.DeletedAt IS NULL AND u.ManagerId IS NOT NULL"

' CTE — WITH keyword (CTE name must NOT colour as table)
sql = "WITH RecentOrders AS (SELECT UserId, COUNT(*) AS OrderCount FROM dbo.Orders WHERE CreatedAt >= DATEADD(MONTH, -3, GETDATE()) GROUP BY UserId) SELECT u.Name, r.OrderCount FROM dbo.Users u JOIN RecentOrders r ON r.UserId = u.UserId ORDER BY r.OrderCount DESC"

' Mixed [brackets] and bare names in same query
sql = "SELECT u.Name, [Value#], Score FROM [SampleDb].[dbo].[Users] u INNER JOIN dbo.Scores s ON s.UserId = u.UserId WHERE u.Category = 'ACME'"

' Nested escaped quotes inside SQL
sql = "SELECT u.Name FROM dbo.Users u WHERE u.Tag = ""special"" AND u.IsActive = 1"

' Numeric literals throughout
sql = "SELECT * FROM dbo.Tiers WHERE MinScore >= 0 AND MaxScore <= 100 AND TierId IN (1, 2, 3) AND Multiplier BETWEEN 1.5 AND 3.14"

' Deep dot-chain with mixed brackets and bare names
sql = "SELECT a.Name, b.Value, c.Code FROM [SampleDb].[dbo].Orders a JOIN dbo.[Product List] b ON b.OrderId = a.OrderId JOIN dbo.Categories c ON c.Id = b.CategoryId"


' ── SECTION 3  MERGE statements ──────────────────────────────────────────────

Dim mergeSql

' Basic MERGE — [db].[schema].[table] target, bare-word source alias
mergeSql = "MERGE [WIPdb].[dbo].[PartsOrderDtl] AS tgt " & _
           "USING (SELECT 1 AS ID) AS src " & _
           "ON tgt.ID = src.ID " & _
           "WHEN MATCHED THEN UPDATE SET tgt.Value = src.Value " & _
           "WHEN NOT MATCHED THEN INSERT (ID, Value) VALUES (src.ID, src.Value);"

' MERGE with full column list UPDATE + INSERT + VBScript variable interpolation
mergeSql = _
    "MERGE [WIPdb].[dbo].[PartsOrderDtl] AS tgt " & _
    "USING (SELECT " & _
        svID & " AS ID, " & _
        "'" & svParent & "' AS Parent, " & _
        "'" & svComponent & "' AS Component " & _
    ") AS src " & _
    "ON tgt.ID = src.ID " & _
        "AND tgt.Parent = src.Parent " & _
        "AND tgt.Component = src.Component " & _
    "WHEN MATCHED THEN UPDATE SET " & _
        "tgt.ComponentDesc = '" & svDesc & "', " & _
        "tgt.ReqQuantity = " & svQty & " " & _
    "WHEN NOT MATCHED THEN INSERT " & _
    "(ID, Parent, Component, ComponentDesc, ReqQuantity) VALUES (" & _
        svID & ", " & _
        "'" & svParent & "', " & _
        "'" & svComponent & "', " & _
        "'" & svDesc & "', " & _
        svQty & _
    ");"

' MERGE with bare-word table (no brackets)
mergeSql = "MERGE dbo.Inventory AS target " & _
           "USING dbo.IncomingStock AS source ON target.SKU = source.SKU " & _
           "WHEN MATCHED THEN UPDATE SET target.Qty = target.Qty + source.Qty " & _
           "WHEN NOT MATCHED THEN INSERT (SKU, Qty) VALUES (source.SKU, source.Qty);"


' ── SECTION 4  Variable concatenation ────────────────────────────────────────

stmt = "SELECT ProductCode, ProductName FROM [SampleDb].[dbo].[Products] WITH (NOLOCK) WHERE Category = '" & category & "' AND ("

Dim prefixArray
prefixArray = Split(productPrefix, ",")
For i = 0 To UBound(prefixArray)
    If i > 0 Then
        stmt = stmt & " OR "
    End If
    stmt = stmt & "ProductCode LIKE '" & Trim(prefixArray(i)) & "%'"
Next

stmt = stmt & ") ORDER BY ProductCode"


' ── SECTION 5  Multi-line continuation ───────────────────────────────────────

strQuery = "SELECT o.OrderId, o.Total, u.Name " & _
           "FROM dbo.Orders o " & _
           "INNER JOIN dbo.Users u ON u.UserId = o.UserId " & _
           "WHERE o.Category = '" & category & "' " & _
           "AND o.Status = '" & status & "' " & _
           "AND o.Total > " & minTotal & " " & _
           "ORDER BY o.CreatedAt DESC"


' ── SECTION 6  Function return analysis ──────────────────────────────────────

' BuildBOMCTE — returns a SQL CTE string (should be confirmed as sqlFunc, no warning)
Dim sql3b
sql3b = BuildBOMCTE(gpSKU, gpWeekend) & _
    "SELECT a.*, b.ReqQuantity " & _
    "FROM BOM a " & _
    "LEFT JOIN [WIPdb].[dbo].[PartsOrderDtl] b " & _
    "    ON b.ID = " & gpID & " AND b.Parent = '' AND b.Component = a.Child " & _
    "ORDER BY a.Level"

' GetStatusFilter — returns a SQL WHERE fragment (should be confirmed as sqlFunc, no warning)
Dim filteredSql
filteredSql = "SELECT UserId, Name FROM dbo.Users u " & GetStatusFilter(gpStatus) & " ORDER BY u.Name"

' BadHelper — returns a non-SQL plain string (should warn on use in SQL context)
Dim warnSql
warnSql = "SELECT * FROM dbo.Orders WHERE " & BadHelper(gpParam)

Function BuildBOMCTE(sku, weekend)
    BuildBOMCTE = _
        "WITH BOM (Company, Parent, Child, EffDate, CloseDate, Level) AS ( " & _
        "    SELECT a.Company, a.Parent, a.Child, a.EffDate, a.CloseDate, 0 AS Level " & _
        "    FROM [WIPdb].[dbo].[BOM] a " & _
        "    WHERE a.Parent = '" & Replace(sku, "'", "''") & "' " & _
        "      AND a.EffDate <= '" & weekend & "' AND a.CloseDate >= '" & weekend & "' " & _
        "    UNION ALL " & _
        "    SELECT a.Company, a.Parent, a.Child, a.EffDate, a.CloseDate, b.Level + 1 " & _
        "    FROM [WIPdb].[dbo].[BOM] a " & _
        "    INNER JOIN BOM b ON b.Company = a.Company AND b.Child = a.Parent " & _
        "    WHERE a.EffDate <= '" & weekend & "' AND a.CloseDate >= '" & weekend & "' " & _
        ") "
End Function

' Returns a WHERE fragment — still SQL-ish, should be confirmed as sqlFunc
Function GetStatusFilter(statusVal)
    GetStatusFilter = "WHERE u.IsActive = 1 AND u.Status = '" & Replace(statusVal, "'", "''") & "' "
End Function

' Returns a plain label string — NOT SQL (should trigger warning when used in SQL concat)
Function BadHelper(param)
    BadHelper = "Label: " & param
End Function

' Returns a number, not a string at all — should trigger stronger warning
Function GetRowLimit(n)
    GetRowLimit = n * 10
End Function

' Warning: GetRowLimit returns a number, not a string or SQL fragment
Dim rowLimitSql
rowLimitSql = "SELECT TOP " & GetRowLimit(5) & " * FROM dbo.Orders WHERE IsActive = 1"


' ── SECTION 7  whereFilters fragment propagation ─────────────────────────────

' whereFilters starts as a real SQL fragment (WHERE EXISTS ...) so it lands in
' sqlVars and all subsequent appends are coloured without warnings.
Dim whereFilters
whereFilters = "WHERE EXISTS (SELECT 1 FROM dbo.BOM c " & _
               "WHERE c.Company = a.Company " & _
               "AND c.Child = a.Parent " & _
               "AND c.Workcenter = '" & Replace(gpWorkcenter, "'", "''") & "') "

If gpWorkcenter <> "" Then
    whereFilters = whereFilters & "AND a.Workcenter = '" & Replace(gpWorkcenter, "'", "''") & "' "
End If

If Not gpIncludeRaw Then
    whereFilters = whereFilters & "AND a.SecondType <> 'R' "
End If

Dim mainSql
mainSql = BuildBOMCTE(gpSKU, gpWeekend) & _
    "SELECT a.*, b.ReqQuantity " & _
    "FROM BOM a " & _
    "LEFT JOIN [WIPdb].[dbo].[PartsOrderDtl] b " & _
    "    ON b.ID = " & gpID & " AND b.Parent = '' AND b.Component = a.Child " & _
    whereFilters & " " & _
    "ORDER BY a.Level"


' ── SECTION 8  Warning squiggly — SQL variable reassigned to plain string ────

stmt = "Something went wrong, please try again."   ' <-- should show warning squiggly


' ── SECTION 9  Edge cases ────────────────────────────────────────────────────

' Empty string and number string — not SQL
Dim empty, numStr
empty = ""
numStr = "12345"

' SQL verb only, no clause — must NOT colour
Dim notSql1, notSql2
notSql1 = "SELECT is not a valid response here"
notSql2 = "Please execute the plan as discussed"

' @params only — all should get @param colour
sql = "UPDATE dbo.Settings SET Value = @value, UpdatedBy = @userId, UpdatedAt = GETDATE() WHERE SettingKey = @key AND Scope = @scope"

%>
