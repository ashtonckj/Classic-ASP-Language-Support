# 📁 **FILE STRUCTURE EXPLANATION**

Let me explain what each file does:

## **Core Extension Files:**
```
src/
├── extension.ts                          ← 🎯 MAIN ENTRY POINT
│   └── Registers all providers, formatters, commands
│   └── This is where everything gets activated
```

---

## **Formatter Files** (Handle code formatting):
```
src/formatter/
├── htmlFormatter.ts                      ← 🎨 HTML/CSS/JS Formatting
│   └── Uses Prettier to format HTML, CSS, JavaScript
│   └── Extracts ASP blocks before formatting
│   └── Restores ASP blocks after formatting
│
└── aspFormatter.ts                       ← 🎨 ASP Code Formatting
    └── Formats VBScript code inside <% %>
    └── Handles indentation, keyword casing
    └── Formats operators and keywords
```

**What triggers formatting?**
- When you press **Shift+Alt+F** (Format Document)
- When you save (if format on save is enabled)

---

## **Provider Files** (Handle autocomplete/IntelliSense):
```
src/providers/
├── htmlCompletionProvider.ts             ← 💡 HTML Autocomplete
│   └── Shows HTML tag suggestions when you type 
│   └── Shows HTML attribute suggestions inside tags
│   └── Handles auto-closing tags when you type >
│   └── Handles Enter key for smart tag closing
│
├── aspCompletionProvider.ts              ← 💡 ASP Autocomplete
│   └── Shows Response, Request, Server, etc.
│   └── Shows VBScript keywords (If, Dim, For, etc.)
│   └── Shows methods when you type Response.
│
├── cssCompletionProvider.ts              ← 💡 CSS Autocomplete
│   └── Shows CSS properties inside <style> tags
│   └── Only triggers when inside { }
│
└── jsCompletionProvider.ts               ← 💡 JavaScript Autocomplete
    └── Shows JS keywords inside <script> tags
    └── Shows document. methods when you type document.
    └── Shows console. methods when you type console.
```

**What triggers providers?**
- Typing specific characters (like `<`, `.`, space)
- Manually pressing **Ctrl+Space**

---

## **Utility Files** (Helper functions):
```
src/utils/
└── documentHelper.ts                     ← 🔧 Context Detection
    └── Detects if cursor is in HTML, CSS, JS, or ASP
    └── Checks if cursor is inside <style>, <script>, <% %>
    └── Gets current tag name
```

---

## **Constant Files** (Data/lists):
```
src/constants/
├── htmlTags.ts                          ← 📋 List of HTML tags
├── htmlAttributes.ts                    ← 📋 List of HTML attributes
└── aspKeywords.ts                       ← 📋 List of ASP objects/keywords
```

---

## **Configuration Files:**
```
Root Files:
├── package.json                         ← ⚙️ Extension configuration
│   └── Defines language, grammars, snippets
│   └── Settings, keybindings, commands
│
├── language-configuration.json          ← ⚙️ Language behavior
│   └── Auto-closing pairs (quotes, brackets)
│   └── Comment syntax
│   └── Brackets matching
│
syntaxes/
├── asp.tmLanguage.json                  ← 🎨 Syntax highlighting rules
│   └── Defines colors for ASP code
│   └── Inherits HTML highlighting
│
└── asp-injections.tmLanguage.json       ← 🎨 ASP code injection
    └── Allows ASP blocks inside HTML
```

---

## **Snippet Files** (Code templates):
```
snippets/
├── html.json                            ← 📝 HTML snippets
├── asp.json                             ← 📝 ASP snippets
└── javascript.json                      ← 📝 JavaScript snippets
```

---

## **🔄 How it all works together:**
```
User types in .asp file
         ↓
extension.ts activates
         ↓
Registers all providers
         ↓
┌────────┬────────┬────────┬────────┐
│  HTML  │  ASP   │  CSS   │   JS   │
│Provider│Provider│Provider│Provider│
└────────┴────────┴────────┴────────┘
         ↓
documentHelper.ts detects context
         ↓
Correct provider shows suggestions
         ↓
User accepts → snippet inserted