<h3 align="center">
	<img src="images/icon.png" alt="Classic ASP Language Support logo" width="100" height="100"><br>
	<strong>Classic ASP Language Support</strong>
</h3>

<p align="center">
    <strong>Format, navigate and error-check Classic ASP and VBScript, with your <code>#include</code> files understood.</strong>
</p>

<p align="center">
    <a href="https://marketplace.visualstudio.com/items?itemName=ashtonckj.classic-asp-language-support"><img alt="VS Marketplace version" src="https://img.shields.io/badge/Marketplace-0.7.0-b7bdf8?style=for-the-badge&labelColor=363a4f&logo=visual-studio-code&cacheSeconds=86400"/></a>
    <a href="https://open-vsx.org/extension/ashtonckj/classic-asp-language-support"><img alt="Open VSX version" src="https://img.shields.io/open-vsx/v/ashtonckj/classic-asp-language-support?style=for-the-badge&label=Open%20VSX&labelColor=363a4f&color=c6a0f6&cacheSeconds=86400"/></a>
    <a href="https://marketplace.visualstudio.com/items?itemName=ashtonckj.classic-asp-language-support"><img alt="Installs, VS Code Marketplace and Open VSX together" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fashtonckj%2FClassic-ASP-Language-Support%2Fbadges%2Finstalls.json&style=for-the-badge&labelColor=363a4f&cacheSeconds=3600"/></a>
    <a href="https://github.com/ashtonckj/Classic-ASP-Language-Support/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-b7bdf8?style=for-the-badge&labelColor=363a4f&cacheSeconds=86400"/></a>
</p>

<p align="center">
    <img src="https://raw.githubusercontent.com/ashtonckj/Classic-ASP-Language-Support/main/images/demo.gif" alt="Format Document tidying a messy Classic ASP page, IntelliSense listing Recordset members, a hover and Ctrl+Click into a function in an #include file, F2 renaming a variable everywhere, and the same page in four colour themes">
    <br>
    <sub>Dark Modern, Light Modern, Monokai and <a href="https://github.com/catppuccin/vscode">Catppuccin</a></sub>
</p>

## What it does

- **Formats the whole page in one go.** VBScript, HTML, CSS, JavaScript and the SQL in your strings, with the keyword casing you choose.
- **Follows your includes.** Go to Definition, Find All References and Rename work across `#include` files, and moving a file offers to fix every include that pointed at it.
- **Finds mistakes before IIS does.** An `If` without `End If`, a missing `Set`, an include that doesn't exist, an undeclared name under `Option Explicit` and a call with the wrong number of arguments.
- **Knows your objects.** After `Set rs = Server.CreateObject("ADODB.Recordset")`, typing `rs.` lists its methods and properties; hover explains `Response`, `vbCrLf`, `Mid` and your own Subs.
- **Colours it properly.** ASP blocks get a tint, SQL inside strings is coloured as SQL, and your own variables, functions and Subs as what they are.
- **Helps in every part of the page.** HTML, CSS and JavaScript get their own completion, hover and checks, and none of them fire inside your VBScript.

## ✨ Getting started

1. Install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ashtonckj.classic-asp-language-support), or in VSCodium, Cursor and other editors that use [Open VSX](https://open-vsx.org/extension/ashtonckj/classic-asp-language-support): search for **Classic ASP Language Support** in the Extensions view.
2. Open your site's folder and any `.asp`, `.inc` or `.asa` file.
3. Press `Alt + Shift + F` (`Option + Shift + F` on a Mac) to format it.

If the folder you open is not your IIS application's root, set `classicAsp.virtualRoot` to the root, so `#include virtual="/…"` and links like `href="/css/site.css"` are found.

| Do this | Press |
|---|---|
| Format the page / the selected lines | `Alt + Shift + F` / `Ctrl + K Ctrl + F` |
| Go to a definition, even in an include | `F12` or `Ctrl + Click` |
| Rename a variable, Sub or Function everywhere | `F2` |
| Find every use | `Shift + F12` |
| Find a Sub or Function in the workspace | `Ctrl + T` |
| Insert a snippet | type its prefix (`rsloop`, `dbconn`, `rw`, `inc` …), then `Tab` |

To see what Format Document would change before it does, run **Classic ASP: Preview Formatting** from the Command Palette.

## ⚙️ Settings you might change

| Setting | Default | |
|---|---|---|
| `classicAsp.keywordCase` | `PascalCase` | How keywords and built-in functions are written: `PascalCase`, `UPPERCASE` or `lowercase` |
| `classicAsp.virtualRoot` | *(the open folder)* | Your IIS application root, for `#include virtual` and root-relative links |
| `classicAsp.prettier.printWidth` | `80` | Where HTML, CSS and JavaScript lines wrap |

The rest are under **Settings → Extensions → Classic ASP**.

## Why won't it format?

Format Document leaves a page alone, and says why, when formatting could break it:

- **Tags or blocks don't pair up.** An `If` with no `End If`, a `<div>` never closed, a `<%` with no `%>`. The message names the first one and its line; **Go to Issue** takes you there. Fix it and format again.
- **Prettier can't read the HTML.** The message gives the line in your page; **Go to Line** takes you there, and **Show Details** shows Prettier's own error.
- **The page is JScript** (`<%@ Language="JScript" %>`). The formatter knows VBScript only, so it leaves the page as it is.

When formatting runs on save, it says nothing and just saves.

## Silencing a warning

If a warning is wrong for your page, press `Ctrl + .` on it and choose **Ignore on this line** or **Ignore in this file**. That writes a comment the extension reads:

```asp
<%
' asp-ignore-next-line missing-set
rs = GetRecordset()
%>
<!-- asp-ignore-next-line html-tag -->
<div class="opened-in-header-include">
```

`asp-ignore-file` silences a code for the whole page; with no code, it silences everything. The comment travels with the file, so everyone who opens it sees the same. A structure warning you silence still stops Format Document, because the page still can't be formatted safely.

## Replacing another Classic ASP extension

This extension includes syntax highlighting and snippets, so it replaces **[Classic ASP Syntaxes and Snippets][Classic ASP Syntaxes & Snippets]** and **[ASP Classic Support][ASP Classic Support]**. Two extensions that read the same `.asp` files fight over colours and completions, so when it finds one it offers to uninstall it, or to open it in the Extensions view so you can disable it. Your files are not touched.

`editor.linkedEditing` does what [Auto Rename Tag] did, ASP between the tags or not. [Error Lens] and [Indent Rainbow] work well alongside it.

---

## 📋 Known limitations

- **Formatting is refused while tags or blocks don't pair up** (see above). A page that opens a `<div>` in one include and closes it in another can't be formatted.
- **`#include virtual` needs the right root.** It resolves from `classicAsp.virtualRoot`, or the open folder when that is empty.
- **A `<%= %>` that writes a tag inside an `onclick="…"` can colour the rest of the line wrongly.** VS Code's HTML grammar owns attribute values; the page still runs correctly.

## Links

[Changelog](CHANGELOG.md) · [Report a bug or ask for a feature](https://github.com/ashtonckj/Classic-ASP-Language-Support/issues) · [Contributing](CONTRIBUTING.md) · [Open VSX](https://open-vsx.org/extension/ashtonckj/classic-asp-language-support)

<table align="center">
<tr>
<td align="center" width="180"><a href="https://prettier.io/"><img src="images/ext-prettier.png" width="56" alt="Prettier"></a><br><b>Prettier</b><br><sub>formats the HTML, CSS and JavaScript</sub></td>
<td align="center" width="180"><a href="https://marketplace.visualstudio.com/items?itemName=jtjoo.classic-asp-html"><img src="images/ext-classic-asp-syntaxes.png" width="56" alt="Classic ASP Syntaxes and Snippets"></a><br><b>Classic ASP Syntaxes and Snippets</b><br><sub>by Jintae Joo</sub></td>
<td align="center" width="180"><a href="https://marketplace.visualstudio.com/items?itemName=zbecknell.asp-classic-support"><img src="images/ext-asp-classic-support.png" width="56" alt="ASP Classic Support"></a><br><b>ASP Classic Support</b><br><sub>by Zachary Becknell</sub></td>
</tr>
</table>

<p align="center"><sub>No need to install these alongside, as running two Classic ASP extensions makes them fight over colours.</sub></p>

Built on [Prettier](https://prettier.io/) and the TypeScript, HTML and CSS language services. Region highlighting started from Zachary Becknell's [ASP Classic Support](https://github.com/zbecknell/asp-classic-support), and the snippets ideas were taken from Jintae Joo's [Classic ASP Syntaxes and Snippets](https://github.com/jtjoo/vscode-classic-asp-extension).

---

<div align="center">

If it saves you time, a ⭐ on [GitHub](https://github.com/ashtonckj/Classic-ASP-Language-Support) or a rating on the Marketplace helps others find it.<br>
**Made with ❤️ for the Classic ASP community**

</div>

[Error Lens]: https://marketplace.visualstudio.com/items?itemName=usernamehw.errorlens
[Auto Rename Tag]: https://marketplace.visualstudio.com/items?itemName=formulahendry.auto-rename-tag
[Indent Rainbow]: https://marketplace.visualstudio.com/items?itemName=oderwat.indent-rainbow
[ASP Classic Support]: https://marketplace.visualstudio.com/items?itemName=zbecknell.asp-classic-support
[Classic ASP Syntaxes & Snippets]: https://marketplace.visualstudio.com/items?itemName=jtjoo.classic-asp-html
