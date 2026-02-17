<h3 align="center">
	<img src="images/icon.png" alt="Classic ASP Language Support Logo" width="100" height="100"><br>
	Classic ASP Language Support for <a href="https://code.visualstudio.com">VSCode</a><br>
    <img src="https://raw.githubusercontent.com/catppuccin/catppuccin/main/assets/misc/transparent.png" height="30" width="0px"/>
    
[![Version](https://img.shields.io/visual-studio-marketplace/v/ashtonckj.classic-asp-language-support?style=for-the-badge&colorA=363a4f&colorB=b7bdf8&logo=visual-studio-code&cacheSeconds=3600)](https://marketplace.visualstudio.com/items?itemName=ashtonckj.classic-asp-language-support)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/ashtonckj.classic-asp-language-support?style=for-the-badge&colorA=363a4f&colorB=8aadf4&cacheSeconds=3600)](https://marketplace.visualstudio.com/items?itemName=ashtonckj.classic-asp-language-support)
    <a href="https://github.com/ashtonckj/Classic-ASP-Language-Support/issues"><img src="https://img.shields.io/github/issues/ashtonckj/Classic-ASP-Language-Support?colorA=363a4f&colorB=f5a97f&style=for-the-badge&cacheSeconds=3600"></a>
    <a href="https://github.com/ashtonckj/Classic-ASP-Language-Support/LICENSE"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8&cacheSeconds=3600"/></a>
</h3>

---

<h4 align="center">
    <em>"Finally, a formatter that understands Classic ASP! This extension has made maintaining legacy codebases so much easier."</em>
</h4>

---

## ✨ What's Inside

<table>
    <tr>
        <td width="33%" align="center" valign="top">
            <h3>🎨 Smart Formatting</h3>
            <p>Multi-language formatting for VBScript, HTML, CSS, and JavaScript with customisable keyword casing</p>
            <p></p>
        </td>
        <td width="33%" align="center" valign="top">
            <h3>🌈 Syntax Highlighting</h3>
            <p>Beautiful, theme-compatible syntax colouring for ASP regions and SQL queries</p>
            <p></p>
        </td>
        <td width="33%" align="center" valign="top">
            <h3>💡 IntelliSense</h3>
            <p>Auto-completion for ASP objects, VBScript keywords, HTML, CSS, and JavaScript</p>
            <p></p>
        </td>
    </tr>
</table>

---

## 📸 See It In Action

### 🎨 Formatting Before & After
<!-- PLACEHOLDER: Add GIF showing messy ASP code being formatted -->
<!-- ![Formatting Demo](images/formatting-demo.gif) -->
<details>
<summary>📝 <b>What you'll see in this demo</b></summary>

- Unformatted ASP code with inconsistent indentation
- One-click formatting with `Alt + Shift + F`
- Clean, properly indented VBScript, HTML, and inline ASP
</details>

<br>

### 🌈 Syntax Highlighting
<!-- PLACEHOLDER: Add GIF showing syntax highlighting for ASP regions and SQL -->
<!-- ![Syntax Highlighting Demo](images/syntax-demo.gif) -->
<details>
<summary>📝 <b>What you'll see in this demo</b></summary>

- ASP region highlighting with customisable background colours
- SQL syntax colouring inside VBScript strings
- Theme compatibility (light and dark modes)
</details>

<br>

### 📋 Snippets Quick Insert
<!-- PLACEHOLDER: Add GIF showing snippet usage -->
<!-- ![Snippets Demo](images/snippets-demo.gif) -->
<details>
<summary>📝 <b>What you'll see in this demo</b></summary>

- Quick insertion of common ASP patterns
- Database connection templates
- Loop and conditional structures
</details>

<br>

### ⚙️ Multi-Block Formatting
<!-- PLACEHOLDER: Add GIF showing complex multi-block ASP formatting -->
<!-- ![Multi-Block Demo](images/multiblock-demo.gif) -->
<details>
<summary>📝 <b>What you'll see in this demo</b></summary>

- If/Else/Loop structures spanning multiple `<% %>` blocks
- Inline ASP expressions in HTML attributes
- Complex mixed HTML/ASP structures
</details>

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

**Example:**
```asp
<!-- Before -->
<!DOCTYPE html><html><body>
<div><h1>Welcome <%=username%>!</h1>
<%
dim age
age=request.form("age")
if age>=18 then
response.write("adult")
end if
%>
</div></body></html>

<!-- After -->
<!DOCTYPE html>
<html>
  <body>
    <div>
      <h1>Welcome <%= username %>!</h1>
      <%
      Dim age
      age = Request.Form("age")
      If age >= 18 Then
        Response.Write("adult")
      End If
      %>
    </div>
  </body>
</html>
```
</details>

<details>
<summary><strong>💡 IntelliSense & Auto-Completion</strong></summary>

- ✅ **HTML**: Tag and attribute suggestions with smart auto-closing
- ✅ **CSS**: Property completion inside `<style>` tags
- ✅ **JavaScript**: Keyword and object completion inside `<script>` tags
- ✅ **ASP/VBScript**: Response, Request, Server, Session, Application objects and VBScript keywords
</details>

<details>
<summary><strong>📝 Snippets</strong></summary>

- ✅ Pre-built snippets for HTML, ASP, and JavaScript patterns
- ✅ Quick insertion for common structures (loops, conditionals, database connections)
- ✅ Customisable templates for your workflow
</details>

<details>
<summary><strong>🌈 Syntax Highlighting</strong></summary>

- ✅ ASP region highlighting with customisable colours
- ✅ Compatible with all VS Code themes
- ✅ Comprehensive SQL syntax colouring with advanced support
- ✅ Toggleable highlighting for `<% %>` blocks
- ✅ Distinct colours for keywords, functions, data types, operators, and parameters
</details>

---

## ⚙️ Configuration

<details>
<summary><strong>⚙️ Formatter Settings</strong></summary>

Access settings via `File → Preferences → Settings` and search for "Classic ASP Language Support".

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `aspLanguageSupport.keywordCase` | `PascalCase` | `lowercase`, `UPPERCASE`, `PascalCase` | VBScript keyword formatting style |
| `aspLanguageSupport.useTabs` | `false` | `true`, `false` | Use tabs instead of spaces for ASP code |
| `aspLanguageSupport.indentSize` | `2` | `2`, `4`, `8` | Number of spaces per indent level for ASP code |
</details>

<details>
<summary><strong>🎨 Prettier Settings (HTML/CSS/JS)</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `aspLanguageSupport.prettier.printWidth` | `80` | Maximum line length |
| `aspLanguageSupport.prettier.tabWidth` | `2` | Spaces per indentation level |
| `aspLanguageSupport.prettier.useTabs` | `false` | Use tabs instead of spaces |
| `aspLanguageSupport.prettier.bracketSameLine` | `true` | Put `>` of multi-line HTML elements on last line |
| `aspLanguageSupport.prettier.semi` | `true` | Add semicolons at end of JavaScript statements |
| `aspLanguageSupport.prettier.singleQuote` | `false` | Use single quotes instead of double quotes in JavaScript |
| `aspLanguageSupport.prettier.arrowParens` | `always` | Include parentheses around arrow function parameters |
| `aspLanguageSupport.prettier.trailingComma` | `es5` | Print trailing commas where valid in ES5 |
| `aspLanguageSupport.prettier.endOfLine` | `lf` | Line ending style |
| `aspLanguageSupport.prettier.htmlWhitespaceSensitivity` | `css` | How to handle whitespace in HTML |
</details>

<details>
<summary><strong>🌈 Completion & Highlighting Settings</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `aspLanguageSupport.enableHTMLCompletion` | `true` | Enable HTML tag and attribute auto-completion |
| `aspLanguageSupport.enableCSSCompletion` | `true` | Enable CSS property auto-completion |
| `aspLanguageSupport.enableJSCompletion` | `true` | Enable JavaScript auto-completion |
| `aspLanguageSupport.enableASPCompletion` | `true` | Enable ASP object and VBScript keyword auto-completion |
| `aspLanguageSupport.highlightAspRegions` | `true` | Highlight ASP code regions with background colours |
| `aspLanguageSupport.bracketLightColor` | `rgba(255, 100, 0, .2)` | ASP bracket colour for light themes |
| `aspLanguageSupport.bracketDarkColor` | `rgba(0, 100, 255, .2)` | ASP bracket colour for dark themes |
| `aspLanguageSupport.codeBlockLightColor` | `rgba(100,100,100,0.1)` | ASP code block colour for light themes |
| `aspLanguageSupport.codeBlockDarkColor` | `rgba(220,220,220,0.1)` | ASP code block colour for dark themes |
| `aspLanguageSupport.enableSQLHighlighting` | `true` | Enable/disable SQL syntax colouring in VBScript strings |
</details>

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
