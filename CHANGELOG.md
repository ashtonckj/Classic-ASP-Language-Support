# Changelog

All notable changes to the "ASP Code Formatter" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2025-02-XX (Soon)

### ✨ Added
- New feature here

### 🐛 Fixed
- Bug fix here

### 🔄 Changed
- Changed behavior here


## [0.0.1] - 2025-01-23

### 🎉 Initial Release

First public release of ASP Code Formatter!

### ✨ Added

#### VBScript Formatting
- Smart indentation for Classic ASP (VBScript) code blocks
- Support for all major control structures:
  - `If/Then/Else/ElseIf/End If`
  - `For/Next` and `For Each/Next`
  - `While/Wend` and `Do/Loop` variations
  - `Select Case/Case/End Select`
  - `Sub/Function/End Sub/End Function`
  - `With/End With`
  - `Class/Property/End Class/End Property`
- Customizable keyword case formatting (lowercase, UPPERCASE, PascalCase)
- Automatic spacing around operators (`=`, `+`, `-`, `*`, `/`, `&`, `<>`, `<`, `>`, `<=`, `>=`)
- Smart formatting for ASP objects (`Response`, `Request`, `Server`, `Session`, `Application`)

#### HTML/CSS/JavaScript Formatting
- Integrated Prettier for professional HTML formatting
- CSS formatting within `<style>` tags
- JavaScript formatting within `<script>` tags
- Customizable Prettier settings (print width, tab width, quotes, semicolons, etc.)

#### Multi-Language Support
- Intelligent masking system to separate ASP from HTML/CSS/JS during formatting
- Support for inline ASP expressions (`<%= variable %>`)
- Support for multi-line ASP code blocks
- Proper indentation preservation between HTML and ASP code

#### Customization Options
- **ASP Settings:**
  - Keyword case style (lowercase/UPPERCASE/PascalCase)
  - Indent style (spaces/tabs)
  - Indent size (2/4/8 spaces)
- **Prettier Settings:**
  - Print width
  - Tab width
  - Use tabs option
  - Semicolon preference
  - Quote style (single/double)
  - HTML whitespace sensitivity

#### User Experience
- Format on command with `Alt + Shift + F` (Windows/Linux) or `Option + Shift + F` (Mac)
- Automatic language detection for `.asp` files
- Clear settings interface in VS Code preferences
- Detailed error handling and fallback mechanisms

### 📝 Notes

- This is the initial release, feedback and bug reports are welcome!
- ASP objects (`Response`, `Request`, etc.) are always formatted in PascalCase regardless of keyword case setting
- Variable names are preserved as written and not modified by the formatter

---

## [Unreleased]

### Planned Features
- Snippet support for common ASP patterns
- Support for ASP comments formatting
- Additional VBScript operators (And, Or, Not, Mod, etc.)
- Format on save option
- Configuration presets (compact, standard, expanded)

---

[0.0.1]: https://github.com/yourusername/asp-code-formatter/releases/tag/v0.0.1