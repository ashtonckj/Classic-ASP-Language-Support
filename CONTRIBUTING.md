# Contributing to Classic ASP Language Support

Thank you for taking the time to contribute! Whether you're fixing a bug,
suggesting an improvement, or adding a new feature — every contribution is
appreciated.

---

## Table of Contents

- [Before You Start](#before-you-start)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

---

## Before You Start

- **Small fixes** (typos, documentation, minor bug fixes) — feel free to open a
  PR directly.
- **Big changes** (new features, architectural changes, formatter behaviour) —
  please **open an issue first** so we can discuss the approach before you invest
  time writing code. This avoids situations where a PR needs significant rework
  or can't be merged.

If you're unsure whether something qualifies as "big", open an issue anyway.
Discussion is always welcome.

---

## Development Setup

**Prerequisites:** Node.js 16+ · VS Code 1.80+

```bash
# 1. Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/Classic-ASP-Language-Support.git
cd Classic-ASP-Language-Support

# 2. Install dependencies
npm install

# 3. Compile the TypeScript source
npm run compile

# 4. Open in VS Code
code .
```

**Running the extension in development:**

Press `F5` in VS Code to launch the **Extension Development Host** — a second
VS Code window with your local build loaded. Open any `.asp` or `.inc` file to
test your changes live.

**Watching for changes:**

```bash
npm run watch
```

This recompiles automatically whenever you save a TypeScript file. You can then
reload the Extension Development Host with `Ctrl+Shift+P → Developer: Reload Window`.

**Linting:**

```bash
npm run lint
```

Please make sure there are no new lint errors introduced by your change before
submitting a PR.

---

## Project Structure

```
src/
├── extension.ts                  # Entry point — registers all providers
├── formatter/
│   ├── aspFormatter.ts           # VBScript indentation and keyword casing
│   └── htmlFormatter.ts          # HTML/CSS/JS formatting via Prettier
├── providers/
│   ├── aspCompletionProvider.ts  # VBScript IntelliSense
│   ├── aspHoverProvider.ts       # Hover docs for keywords, functions, COM
│   ├── aspIndentProvider.ts      # Enter/Tab smart indent + auto-close
│   ├── aspSemanticProvider.ts    # Semantic token colouring (VBScript + SQL)
│   ├── aspStructureDiagnostics*  # Mismatched block detection
│   ├── cssCompletionProvider.ts  # CSS completions inside <style> and style=""
│   ├── cssDiagnosticsProvider.ts # CSS error/warning squiggles
│   ├── htmlCompletionProvider.ts # HTML tag and attribute completions
│   ├── htmlStructureDiagnostics* # Mismatched HTML tag detection
│   ├── includeProvider.ts        # #include resolution and symbol extraction
│   ├── jsCompletionProvider.ts   # JavaScript completions inside <script>
│   ├── linkProvider.ts           # Ctrl+Click navigation for file paths
│   └── sqlSemanticProvider.ts    # SQL string detection and token colouring
├── constants/
│   ├── aspKeywords.ts            # VBScript keywords and built-in functions
│   ├── comObjects.ts             # COM object members (ADODB, Scripting, etc.)
│   ├── htmlGlobals.ts            # HTML global attributes and event attributes
│   ├── htmlTags.ts               # HTML tag list with self-closing flags
│   └── jsKeywords.ts             # JavaScript keywords and snippets
└── utils/
    ├── aspUtils.ts               # Core ASP zone detection (isInsideAspBlock)
    ├── cssUtils.ts               # Virtual CSS document helpers
    ├── documentHelper.ts         # Cursor context helpers
    └── htmlLinkUtils.ts          # HTML file-link attribute detection
syntaxes/
└── asp.tmLanguage.json           # TextMate grammar for syntax highlighting
snippets/
├── asp.json                      # ASP/VBScript snippets
├── html.json                     # HTML snippets
└── javascript.json               # JavaScript snippets
```

---

## Making Changes

1. Create a branch from `main`:

   ```bash
   git checkout -b fix/your-bug-description
   # or
   git checkout -b feat/your-feature-name
   ```

2. Make your changes. Keep commits focused — one logical change per commit.

3. Test manually in the Extension Development Host with real `.asp` files.
   Pay particular attention to edge cases like:
   - Files with both `<%...%>` blocks and `<script>` blocks on the same page
   - Multi-line VBScript with line continuation (`_`)
   - Deeply nested `#include` chains
   - Files with `Option Explicit`

4. Run the linter before committing:

   ```bash
   npm run lint
   ```

---

## Submitting a Pull Request

1. Push your branch and open a PR against `main`.
2. Fill in the PR template — describe what changed and why.
3. Link the related issue if one exists (e.g. `Closes #42`).
4. A maintainer will review your PR. Please be patient — this is a solo-maintained
   project and reviews may take a few days.

**What makes a PR easy to merge:**

- A clear description of the problem being solved and the approach taken
- Focused scope — one fix or feature per PR
- No unrelated formatting changes in files you didn't touch
- Passes `npm run lint` cleanly

---

## Reporting Bugs

Please use the **[Bug Report issue template](.github/ISSUE_TEMPLATE/bug_report.md)**
when opening a bug. Include:

- Your VS Code version (`Help → About`)
- A minimal `.asp` file that reproduces the issue
- What you expected to happen vs. what actually happened

---

## Suggesting Features

Use the **[Feature Request issue template](.github/ISSUE_TEMPLATE/feature_request.md)**.

Good feature requests explain the problem being solved, not just the solution —
"I want X" is less useful than "When I do Y, I have to Z manually every time, which
is tedious because...".