# Changelog

All notable changes to the "Classic ASP Language Support" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-beta] - 2025-02-01

### ✨ Added
- **ASP region highlighting** with customisable colours for light/dark themes
- **SQL syntax colouring** for database queries inside ASP strings
- Shortened and improved snippets for better usability

### 🛠️ Fixed
- Fixed auto-completion bugs and improved stability
- Improved IntelliSense suggestions for HTML, CSS, JavaScript, and ASP

### 🙏 Credits
- **Zachary Becknell** ([ASP Classic Support](LINK_PLACEHOLDER)) - ASP region highlighting implementation

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
- **Jintae Joo** ([Classic ASP Syntaxes and Snippets](LINK_PLACEHOLDER)) - Snippets inspiration

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

[0.2.0-beta]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.0-beta
[0.2.0-alpha]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.2.0-alpha
[0.1.0-alpha]: https://github.com/ashtonckj/Classic-ASP-Language-Support/releases/tag/v0.1.0-alpha