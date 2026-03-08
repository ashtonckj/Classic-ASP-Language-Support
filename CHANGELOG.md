# Changelog

All notable changes to the "Classic ASP Language Support" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.5] - 2026-03-08

### ✨ Added
- **Go to file support for #include directives** - Click on include file paths to navigate directly to the file ([#37](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/37))

### 🛠️ Fixed
- **Fixed #10** - VBScript blocks in inline HTML no longer cause missing IntelliSense suggestions ([#10](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/10))
- **Fixed #31** - Line continuation symbol (`_`) no longer triggers unwanted variable autocomplete ([#31](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/31))
- **Fixed #33** - Include file path autocomplete no longer duplicates directory traversal or suggests incorrect files ([#33](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/33))
- **Fixed #34** - Auto-deindentation now works correctly even when closing `%>` is more than 5000 characters away ([#34](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/34))
- **Fixed #35** - Pressing Enter inside `<% %>` now indents the cursor correctly ([#35](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/35))
- **Fixed #36** - SQL table aliases now colour correctly with bracket notation (e.g., `e.[ColumnName]`) ([#36](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/36))
- **Fixed #38** - Hovering over "Function" in "End Function" now shows the correct definition ([#38](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/38))
- **Improved formatter stability** - Various edge cases fixed

---

## [0.3.4] - 2026-03-01

### ✨ Added
- **Semantic token colouring for VBScript** - Enhanced syntax highlighting for VBScript functions/subs
- **Semantic token colouring for SQL** - Smart SQL detection that only colours actual SQL queries
- **SQL string usage warnings** - Alerts when the same variable is used for both SQL queries and regular strings
- **Hover documentation** - Hover over VBScript keywords for explanations and usage information
- **Smart IntelliSense** - Suggestions for user-defined functions, variables, and included `.inc` file content
- **COM object tracking** - Automatic method suggestions for `CreateObject` instances (ADODB.Recordset, ADODB.Connection, Scripting.Dictionary, FileSystemObject, MSXML2.DOMDocument, WScript.Shell, etc.)
- **Include file autocomplete** - Directory browsing and file suggestions for `<!-- #include file="" -->`

### 🛠️ Fixed
- **Fixed #22** - Resolved incorrect extra indentation in CSS/JS code blocks ([#22](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/22))
- **Fixed #23** - Added support for COM object methods and properties (Recordset, Dictionary, etc.) ([#23](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/23))
- **Fixed #24** - Implemented smarter COM object tracking for VBScript ([#24](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/24))
- **Fixed #25** - Added cross-file IntelliSense for `.inc` files ([#25](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/25))
- **Fixed #26** - Resolved missing SQL keyword colours using semantic tokens ([#26](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/26))

### 🔄 Changed
- **Removed `aspLanguageSupport.enableSQLHighlighting` setting** - No longer needed with smart SQL detection
- **Removed `aspLanguageSupport.enableAspCompletion` setting** - Unnecessary kill switch removed

---

## [0.3.3] - 2026-02-25

### 🛠️ Fixed
- **Fixed #21** - Resolved missing formatter and VBScript highlighting caused by bundling issues in v0.3.2 ([#21](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/21))
- **Reverted bundling changes** - Extension is no longer bundled to ensure all features work correctly

---

## [0.3.2] - 2026-02-24

### 🛠️ Fixed
- **Fixed formatter hotkey not working** - Resolved bundling issue that prevented the formatter from activating with `Alt + Shift + F` (Windows/Linux) or `Option + Shift + F` (Mac)
- **Fixed #20** - Resolved deindentation failures with `ElseIf`, `Else`, and `Case` tags in VBScript ([#20](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/20))

---

## [0.3.1] - 2026-02-23

### 🛠️ Fixed
- **Fixed #19** - Resolved incorrect indentation caused by missing inner closing tags in VBScript ([#19](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/19))
- **Fixed formatter issues** - Resolved various edge cases and improved formatter stability

---

## [0.3.0] - 2026-02-22

### ✨ Added
- **Full native CSS IntelliSense** - Complete CSS property suggestions and validation for inline styles and `<style>` blocks
- **Improved VBScript keywords** - Enhanced VBScript keyword and attribute suggestions
- **Improved JavaScript keywords** - Enhanced JavaScript keyword and attribute suggestions
- **Smart indentation for VBScript** - Smarter indentation that automatically adjusts based on code context
- **Smart deindent for closing tags** - Closing VBScript tags (`End If`, `End Sub`, etc.) automatically deindent correctly
- **Context-aware indentation** - Empty lines receive proper indentation based on surrounding code structure
- **Added .inc file support** - `.inc` files now have the same syntax highlighting and features as `.asp` files

### 🛠️ Fixed
- **Fixed #9** - Added support for CSS properties with full native IntelliSense ([#9](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/9))
- **Fixed #11** - Added missing colours for advanced SQL syntaxes ([#11](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/11))
- **Fixed #13** - Improved variable suggestions and keyword prioritisation in VBScript code blocks ([#13](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/13))

---

## [0.2.5] - 2025-02-12

### ✨ Added
- **Added colours for advanced SQL syntaxes** - Enhanced syntax highlighting for advanced SQL patterns and keywords ([#11](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/11))
- **Added toggleable SQL highlighting setting** - New `aspLanguageSupport.enableSQLHighlighting` setting to show or hide SQL colours in VBScript strings (default: `true`) ([#12](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/12))

---

## [0.2.4] - 2025-02-06

### 🛠️ Fixed
- **Fixed inline ASP delimiter handling** - `<% %>` delimiters now stay on the same line with code instead of being incorrectly removed in multi-line code ([#6](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/6))
- **Fixed inconsistent VBScript method colours** - VBScript functions and methods now have consistent syntax colouring ([#8](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/8))

---

## [0.2.3] - 2025-02-03

### 🛠️ Fixed
- **Fixed `ElseIf` formatting** - `ElseIf` keywords now maintain correct casing instead of being converted to `Elseif` ([#1](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/1))
- **Fixed unexpected indentation in VBScript** - Resolved issue where lines containing certain words caused incorrect indentation ([#3](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/3))
- **Fixed HTML tag indentation** - Resolved extra indentation being added after repeatedly pressing Enter after `<>` tags ([#2](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/2))
- **Fixed autocomplete ranking** - Words and snippets are now properly ranked and suggested in the correct order ([#4](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/4))
- **Fixed HTML comment auto-closing** - HTML comments now auto-close properly with improved Enter key behaviour ([#5](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues/5))

---

## [0.2.2] - 2025-02-02

### 🛠️ Fixed
- **Fixed ASP code colour highlighting** - Resolved broken colours for ASP code blocks across different VS Code themes
- **Fixed SQL syntax colouring in strings** - SQL highlighting now works correctly with both default VS Code themes and custom themes (e.g., Catppuccin)

### ✨ Added
- **Additional SQL keyword support** - Expanded SQL keyword coverage for improved syntax highlighting

---

## [0.2.1] - 2025-02-01

### ✨ Added
- **Enhanced SQL syntax colouring** with comprehensive highlighting for SQL keywords, functions, data types, operators, and multi-word phrases
- **Support for ASP blocks in HTML tags** - Inline ASP expressions in HTML attributes now format correctly

### 🛠️ Fixed
- **Fixed SQL indentation** - SQL queries inside ASP strings now format with proper indentation

---

## [0.2.0-beta] - 2025-02-01

### ✨ Added
- **ASP region highlighting** with customisable colours for light/dark themes
- **SQL syntax colouring** for database queries inside ASP strings
- Shortened and improved snippets for better usability

### 🛠️ Fixed
- Fixed auto-completion bugs and improved stability
- Improved IntelliSense suggestions for HTML, CSS, JavaScript, and ASP

### 🙏 Credits
- **Zachary Becknell** ([ASP Classic Support](https://github.com/zbecknell/asp-classic-support)) - ASP region highlighting implementation

---

## [0.2.0-alpha] - 2025-01-27

### ✨ Added

#### IntelliSense & Auto-Completion
- **HTML auto-completion** for tags and attributes
- **CSS auto-completion** for properties inside `<style>` tags
- **JavaScript auto-completion** for keywords and objects inside `<script>` tags
- **ASP auto-completion** for VBScript keywords and objects (Response, Request, Server, Session, Application)
- Smart tag auto-closing when typing `>` and pressing Enter

#### Snippets
- HTML snippets for common tags and structures
- ASP snippets for Classic ASP patterns (loops, conditionals, database connections)
- JavaScript snippets for common JS patterns

#### Settings
- Enable/disable completion providers for HTML, CSS, JavaScript, and ASP individually

### 🛠️ Fixed
- **Multi-block ASP formatting**: Fixed formatting issues where If/Else/Loops span across multiple `<% %>` blocks with HTML in between
- Improved formatter stability for complex ASP file structures

### 🙏 Credits
- **Jintae Joo** ([Classic ASP Syntaxes and Snippets](https://github.com/jtjoo/vscode-classic-asp-extension)) - Snippets inspiration

---

## [0.1.0-alpha] - 2025-01-23

### 🎉 Initial Release

First public release focused on Classic ASP code formatting.

### ✨ Added

#### VBScript Formatting
- Smart indentation for Classic ASP (VBScript) code blocks
- Support for control structures (If/For/While/Select Case/Sub/Function/With/Class)
- Customisable keyword case formatting (lowercase, UPPERCASE, PascalCase)
- Automatic spacing around operators (`=`, `+`, `-`, `*`, `/`, `&`, comparison operators)
- Smart formatting for ASP objects (Response, Request, Server, Session, Application)

#### HTML/CSS/JavaScript Formatting
- Integrated Prettier for professional HTML, CSS, and JavaScript formatting
- Customisable Prettier settings (print width, tab width, quotes, semicolons, etc.)

#### Multi-Language Support
- Intelligent masking system to separate ASP from HTML/CSS/JS during formatting
- Support for inline ASP expressions (`<%= variable %>`)
- Support for multi-line ASP code blocks

#### Customisation Options
- ASP keyword case style (lowercase/UPPERCASE/PascalCase)
- Indent style (spaces/tabs) and size (2/4/8 spaces)
- Prettier settings for HTML/CSS/JS formatting

---

[0.3.5]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.3.5
[0.3.4]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.3.4
[0.3.3]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.3.3
[0.3.2]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.3.2
[0.3.1]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.3.1
[0.3.0]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.3.0
[0.2.5]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.5
[0.2.4]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.4
[0.2.3]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.3
[0.2.2]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.2
[0.2.1]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.1
[0.2.0-beta]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.0-beta
[0.2.0-alpha]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.0-alpha
[0.1.0-alpha]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.1.0-alpha
