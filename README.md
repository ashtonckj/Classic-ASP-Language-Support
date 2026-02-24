<h3 align="center">
	<img src="images/icon.png" alt="Classic ASP Language Support Logo" width="100" height="100"><br>
	<strong>Classic ASP Language Support for <a href="https://code.visualstudio.com">VSCode</a></strong>
    <img src="images/transparent.png" height="30" width="0px"/>
</h3>

<p align="center">
    <a href="https://marketplace.visualstudio.com/items?itemName=ashtonckj.classic-asp-language-support"><img alt="Version: 0.3.3" src="https://img.shields.io/badge/Version-0.3.3-b7bdf8?style=for-the-badge&labelColor=363a4f&logo=visual-studio-code&cacheSeconds=86400"/></a>
    <a href="https://marketplace.visualstudio.com/items?itemName=ashtonckj.classic-asp-language-support"><img src="https://img.shields.io/visual-studio-marketplace/d/ashtonckj.classic-asp-language-support?style=for-the-badge&colorA=363a4f&colorB=8aadf4&cacheSeconds=3600" alt="Downloads"/></a>
    <a href="https://github.com/ashtonckj/Classic-ASP-Language-Support/issues"><img src="https://img.shields.io/github/issues/ashtonckj/Classic-ASP-Language-Support?colorA=363a4f&colorB=f5a97f&style=for-the-badge&cacheSeconds=3600"></a>
    <a href="https://github.com/ashtonckj/Classic-ASP-Language-Support/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-b7bdf8?style=for-the-badge&labelColor=363a4f&cacheSeconds=86400"/></a>
</p>

---

<h4 align="center">
    <em>"Finally, a formatter that understands Classic ASP! This extension has made maintaining legacy codebases so much easier."</em>
</h4>

---

## ✨ What's Inside

<table>
    <tr>
        <td width="33%" align="center" valign="top">
            <h3><strong>🎨 Smart Formatting</strong></h3>
            <p>Multi-language formatting for VBScript, HTML, CSS, and JavaScript with customisable keyword casing</p>
            <p></p>
        </td>
        <td width="33%" align="center" valign="top">
            <h3><strong>🌈 Syntax Highlighting</strong></h3>
            <p>Beautiful, theme-compatible syntax colouring for ASP regions and SQL queries</p>
            <p></p>
        </td>
        <td width="33%" align="center" valign="top">
            <h3><strong>💡 IntelliSense</strong></h3>
            <p>Auto-completion for ASP objects, VBScript keywords, HTML, CSS, and JavaScript</p>
            <p></p>
        </td>
    </tr>
</table>

---

## 📸 See It In Action

### 🎨 Formatting Before & After
> *Colours in these previews are made possible by the **[Catppuccin Theme](https://github.com/catppuccin/vscode)***

<img src="images/format.gif" height="480">


### 🌈 Syntax Highlighting

<img src="images/sql.gif" width="500">

<!-- Add GIF showing complex multi-block ASP formatting -->
<!--
### ⚙️ Multi-Block Formatting
<details>
<summary>📝 <b>Open Me For A Gif</b></summary>

- If/Else/Loop structures spanning multiple `<% %>` blocks
- Inline ASP expressions in HTML attributes
- Complex mixed HTML/ASP structures
</details>
-->

---

## 🚀 Installation

1. Install from VS Code Extensions Marketplace (search for "Classic ASP Language Support")
2. Or install from `.vsix` file: Extensions → Install from VSIX

---

## 📖 Usage

| Action | Shortcut |
|--------|----------|
| **Format Document** | `Alt + Shift + F` (Windows/Linux)<br>`Option + Shift + F` (Mac) |
| **Trigger IntelliSense** | Start typing or `Ctrl + Space` |
| **Insert Snippet** | Type prefix and press `Tab` |

---

## 🎯 Key Features

<details open>
<summary><strong>🎨 Multi-Language Formatting</strong></summary>

- ✅ **VBScript**: Smart indentation for all control structures (If/For/While/Select Case/Sub/Function)
- ✅ **HTML/CSS/JavaScript**: Professional formatting powered by Prettier
- ✅ **SQL**: Proper indentation for SQL queries inside ASP strings
- ✅ **Customisable keyword casing**: Choose lowercase, UPPERCASE, or PascalCase
- ✅ **Automatic operator spacing**: Proper spacing around `=`, `+`, `&`, etc.
- ✅ **Multi-block support**: Handles structures that span across multiple `<% %>` blocks
- ✅ **Inline ASP support**: Formats ASP expressions in HTML attributes
</details>
<br>

<details open>
<summary><strong>💡 IntelliSense & Auto-Completion</strong></summary>

- **HTML**: Tag and attribute suggestions with smart auto-closing
- **CSS**: Property completion inside in-line and `<style>` tags
- **JavaScript**: Keyword and object completion inside `<script>` tags
- **ASP/VBScript**: Response, Request, Server, Session, Application objects and VBScript keywords
</details>
<br>

<details>
<summary><strong>📝 Snippets</strong></summary>

- ✅ Pre-built snippets for HTML, ASP, and JavaScript patterns
- ✅ Quick insertion for common structures (loops, conditionals, database connections)
</details>
<br>

<details>
<summary><strong>🌈 Syntax Highlighting</strong></summary>

- ✅ ASP region highlighting with customisable colours
- ✅ Compatible with all VS Code themes
- ✅ Comprehensive SQL syntax colouring with advanced support
- ✅ Toggleable highlighting for `<% %>` blocks
- ✅ Distinct colours for keywords, functions, data types, operators, and parameters
</details>
<br>

---

## ⚙️ Configuration

<details>
<summary><strong>⚙️ Formatter Settings</strong></summary>

Access settings via `File → Preferences → Settings` and search for "Classic ASP Language Support".

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `aspLanguageSupport.keywordCase` | `PascalCase` | `lowercase`, `UPPERCASE`, `PascalCase` | ASP/VBScript keyword formatting style |
| `aspLanguageSupport.useTabs` | `false` | `true`, `false` | Use tabs instead of spaces for ASP code indentation |
| `aspLanguageSupport.indentSize` | `2` | `2`, `4`, `8` | Number of spaces per indentation level for ASP code |
| `aspLanguageSupport.asptagsOnSameLine` | `false` | `true`, `false` | Keep `<% %>` on same line as code (default: separate lines) |
</details>
<br>

<details>
<summary><strong>🎨 Prettier Settings (HTML/CSS/JS)</strong></summary>

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `aspLanguageSupport.prettier.printWidth` | `80` | number | Maximum line length (Prettier) |
| `aspLanguageSupport.prettier.tabWidth` | `2` | `2`, `4`, `8` | Spaces per indentation level (Prettier) |
| `aspLanguageSupport.prettier.useTabs` | `false` | `true`, `false` | Use tabs instead of spaces (Prettier) |
| `aspLanguageSupport.prettier.bracketSameLine` | `true` | `true`, `false` | Put `>` of multi-line elements on last line (Prettier) |
| `aspLanguageSupport.prettier.semi` | `true` | `true`, `false` | Add semicolons to JavaScript statements (Prettier) |
| `aspLanguageSupport.prettier.singleQuote` | `false` | `true`, `false` | Use single quotes in JavaScript (Prettier) |
| `aspLanguageSupport.prettier.arrowParens` | `always` | `always`, `avoid` | Arrow function parameter parentheses (Prettier) |
| `aspLanguageSupport.prettier.trailingComma` | `es5` | `none`, `es5`, `all` | Trailing comma style (Prettier) |
| `aspLanguageSupport.prettier.endOfLine` | `lf` | `lf`, `crlf`, `cr`, `auto` | Line ending style (Prettier) |
| `aspLanguageSupport.prettier.htmlWhitespaceSensitivity` | `css` | `css`, `strict`, `ignore` | HTML whitespace handling (Prettier) |
</details>
<br>

<details>
<summary><strong>🌈 Completion & Highlighting Settings</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `aspLanguageSupport.enableSQLHighlighting` | `true` | Enable SQL syntax highlighting inside double-quoted strings (requires reload) |
| `aspLanguageSupport.highlightAspRegions` | `true` | Highlight ASP code regions with background colours |
| `aspLanguageSupport.bracketLightColor` | `rgba(255, 100, 0, 0.2)` | ASP bracket `<% %>` colour (light theme) |
| `aspLanguageSupport.bracketDarkColor` | `rgba(0, 100, 255, 0.2)` | ASP bracket `<% %>` colour (dark theme) |
| `aspLanguageSupport.codeBlockLightColor` | `rgba(100, 100, 100, 0.1)` | ASP code block background (light theme) |
| `aspLanguageSupport.codeBlockDarkColor` | `rgba(220, 220, 220, 0.1)` | ASP code block background (dark theme) |
</details>
<br>

<details>
<summary><strong>💡 IntelliSense & Completion</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `aspLanguageSupport.enableAspCompletion` | `true` | Enable ASP object and VBScript keyword auto-completion |
</details>
<br>

---

## 📋 Known Limitations

> **Note:** These are edge cases that may require manual adjustment

- ASP blocks must be properly closed (`<% ... %>`)
- Complex mixed HTML/ASP structures may require manual adjustment
- Prettier settings only apply to HTML/CSS/JS, not VBScript

---

## 🛠️ Development

<details>
<summary><b>Building from Source</b></summary>

### Prerequisites
- Node.js 16.x or higher
- Visual Studio Code 1.80.0 or higher

### Build Steps

```bash
# Clone the repository
git clone https://github.com/ashtonckj/Classic-ASP-Language-Support.git
cd Classic-ASP-Language-Support

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run extension in debug mode
# Press F5 in VS Code
```
</details>

---

## 🤝 Contributing

Contributions are welcome! If you have ideas, bug reports, or want to improve the extension:

1. 🍴 Fork the repository
2. 🌿 Create a feature branch (`git checkout -b feature/amazing-feature`)
3. 💾 Commit your changes (`git commit -m 'Add amazing feature'`)
4. 📤 Push to the branch (`git push origin feature/amazing-feature`)
5. 🎉 Open a Pull Request

---

## 🙏 Acknowledgements

This extension wouldn't be possible without these amazing projects:

- **[Prettier](https://prettier.io/)** - HTML, CSS, and JavaScript formatting engine
- **Zachary Becknell** ( [ASP Classic Support](https://github.com/zbecknell/asp-classic-support) ) - ASP region highlighting implementation
- **Jintae Joo** ( [Classic ASP Syntaxes and Snippets](https://github.com/jtjoo/vscode-classic-asp-extension) ) - Snippets inspiration and reference

---

<div align="center">

If you find this extension helpful, please consider leaving a ⭐ on GitHub and a rating on the VS Code Marketplace!<br>
**Made with ❤️ for the Classic ASP community**

</div>
