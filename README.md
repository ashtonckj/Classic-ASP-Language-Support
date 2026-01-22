# ASP Code Formatter

A comprehensive code formatter for Classic ASP files that formats VBScript, HTML, CSS, and JavaScript all in one place.

## ✨ Features

- **Multi-Language Formatting**: Formats Classic ASP (VBScript), HTML, CSS, and JavaScript in a single file
- **Smart ASP Formatting**: Intelligent indentation for VBScript control structures (If/For/While/Select Case)
- **Prettier Integration**: Professional HTML, CSS, and JavaScript formatting powered by Prettier
- **Customizable Keyword Case**: Format VBScript keywords in lowercase, UPPERCASE, or PascalCase
- **Flexible Indentation**: Choose between spaces or tabs, with configurable indent sizes
- **Operator Spacing**: Automatically adds proper spacing around operators (=, +, -, *, etc.)
- **Inline ASP Support**: Handles both multi-line `<% %>` blocks and inline `<%= %>` expressions

## 🚀 Installation

1. Install from VS Code Extensions Marketplace (search for "ASP Code Formatter")
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

Access settings via `File → Preferences → Settings` and search for "ASP Formatter".

### ASP (VBScript) Settings

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `aspFormatter.keywordCase` | `PascalCase` | `lowercase`, `UPPERCASE`, `PascalCase` | How to format VBScript keywords |
| `aspFormatter.indentStyle` | `spaces` | `spaces`, `tabs` | Indentation style for ASP code |
| `aspFormatter.indentSize` | `4` | `2`, `4`, `8` | Number of spaces per indent level |

### Prettier (HTML/CSS/JS) Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aspFormatter.prettier.printWidth` | `80` | Maximum line length |
| `aspFormatter.prettier.tabWidth` | `4` | Spaces per indentation level |
| `aspFormatter.prettier.useTabs` | `false` | Use tabs instead of spaces |
| `aspFormatter.prettier.semi` | `true` | Add semicolons in JavaScript |
| `aspFormatter.prettier.singleQuote` | `false` | Use single quotes in JavaScript |

### Example Configuration

```json
{
  "aspFormatter.keywordCase": "PascalCase",
  "aspFormatter.indentStyle": "spaces",
  "aspFormatter.indentSize": 4,
  "aspFormatter.prettier.tabWidth": 4,
  "aspFormatter.prettier.semi": true
}
```

## 🎯 What Gets Formatted

### VBScript Keywords
Control structures (`If`, `For`, `While`, `Select Case`), declarations (`Dim`, `Const`), functions (`Sub`, `Function`), and more.

### ASP Objects
`Response`, `Request`, `Server`, `Session`, `Application` and their methods are always formatted in PascalCase.

### HTML, CSS, JavaScript
Formatted using Prettier with customizable settings for professional code style.

### Operators
Automatic spacing around operators: `x=1` → `x = 1`, `"a"&"b"` → `"a" & "b"`

## 🛠️ Development

### Prerequisites
- Node.js 16.x or higher
- Visual Studio Code 1.80.0 or higher

### Building from Source

```bash
# Clone the repository
git clone https://github.com/yourusername/asp-code-formatter.git
cd asp-code-formatter

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run extension in debug mode
# Press F5 in VS Code
```

## 📝 Known Limitations

- ASP blocks must be properly closed (`<% ... %>`)
- Complex mixed HTML/ASP structures may require manual adjustment
- Prettier settings only apply to HTML/CSS/JS, not VBScript

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

## 🙏 Acknowledgments

- **Prettier** - HTML, CSS, and JavaScript formatting engine
- **Classic ASP Syntaxes and Snippets** by Jintae Joo - Inspiration for ASP language support
- VS Code Extension API documentation and community

## 📮 Support

If you encounter any issues or have suggestions, please [open an issue](https://github.com/yourusername/asp-code-formatter/issues) on GitHub.

---

Made with ❤️ for the Classic ASP community
