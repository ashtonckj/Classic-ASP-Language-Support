# Classic ASP Language Support

Complete language support for Classic ASP files with formatting, IntelliSense, snippets, and syntax highlighting for VBScript, HTML, CSS, and JavaScript.

## ✨ Features

### 🎨 Multi-Language Formatting
- **VBScript**: Smart indentation for all control structures (If/For/While/Select Case/Sub/Function)
- **HTML/CSS/JavaScript**: Professional formatting powered by Prettier
- **SQL**: Proper indentation for SQL queries inside ASP strings
- **Customisable keyword casing**: Choose lowercase, UPPERCASE, or PascalCase for VBScript keywords
- **Automatic operator spacing**: Adds proper spacing around operators (`=`, `+`, `&`, etc.)
- **Multi-block support**: Handles If/Else/Loops that span across multiple `<% %>` blocks
- **Inline ASP support**: Formats ASP expressions in HTML attributes (e.g., `<div class="<%= className %>">`)


### 💡 IntelliSense & Auto-Completion
- **HTML**: Tag and attribute suggestions with smart auto-closing
- **CSS**: Property completion inside `<style>` tags
- **JavaScript**: Keyword and object completion inside `<script>` tags
- **ASP/VBScript**: Response, Request, Server, Session, Application objects and VBScript keywords

### 📝 Snippets
- Pre-built snippets for HTML, ASP, and JavaScript patterns
- Quick insertion for common structures (loops, conditionals, database connections)

### 🌈 Syntax Highlighting
- ASP code region highlighting with customisable colours (compatible with all VS Code themes)
- Comprehensive SQL syntax colouring (keywords, functions, data types, operators, parameters) with full theme support
- Toggleable region highlighting for `<% %>` blocks

## 🚀 Installation

1. Install from VS Code Extensions Marketplace (search for "Classic ASP Language Support")
2. Or install from `.vsix` file: Extensions → Install from VSIX

## 📖 Usage

1. Open any `.asp` file
2. Press `Alt + Shift + F` (Windows/Linux) or `Option + Shift + F` (Mac)
3. Your code is formatted instantly!

### Before:
```asp
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
```

### After:
```asp
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

## ⚙️ Settings

Access settings via `File → Preferences → Settings` and search for "Classic ASP Language Support".

### Formatter Settings

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `aspLanguageSupport.keywordCase` | `PascalCase` | `lowercase`, `UPPERCASE`, `PascalCase` | VBScript keyword formatting style |
| `aspLanguageSupport.useTabs` | `false` | `true`, `false` | Use tabs instead of spaces for ASP code |
| `aspLanguageSupport.indentSize` | `2` | `2`, `4`, `8` | Number of spaces per indent level for ASP code |

### Prettier Settings (HTML/CSS/JS)

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

### Completion & Highlighting Settings

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

## 🛠️ Development

### Prerequisites
- Node.js 16.x or higher
- Visual Studio Code 1.80.0 or higher

### Building from Source

```bash
# Clone the repository
git clone https://github.com/ashtonckj/Classic-ASP-Language-Support.git
cd Classic-ASP-Language-Support

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run extension in debug mode (Press F5 in VS Code)
```

## 📋 Known Limitations

- ASP blocks must be properly closed (`<% ... %>`)
- Complex mixed HTML/ASP structures may require manual adjustment
- Prettier settings only apply to HTML/CSS/JS, not VBScript

## 🤝 Contributing

Contributions are welcome! Feel free to submit issues and pull requests.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

## 🙏 Acknowledgments

- **[Prettier](https://prettier.io/)** - HTML, CSS, and JavaScript formatting engine
- **Zachary Becknell** ( [ASP Classic Support](https://github.com/zbecknell/asp-classic-support) ) - ASP region highlighting implementation
- **Jintae Joo** ( [Classic ASP Syntaxes and Snippets](https://github.com/jtjoo/vscode-classic-asp-extension) ) - Snippets inspiration and reference

## 📮 Support

If you encounter any issues or have suggestions, please [open an issue](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues) on GitHub.

---

**Made with ❤️ for the Classic ASP community**