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

**Prerequisites:** Node.js 20+ · VS Code 1.80+

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

Press `Ctrl+F5` (Run Without Debugging) in VS Code to launch the **Extension
Development Host** — a second VS Code window with your local build loaded. Open
any `.asp` or `.inc` file to test your changes live. (`F5`, with the
debugger attached, has been unreliable since VS Code 1.139.)

**Watching for changes:**

```bash
npm run watch
```

This recompiles automatically whenever you save a TypeScript file. You can then
reload the Extension Development Host with `Ctrl+Shift+P → Developer: Reload Window`.

**Tests and linting:**

```bash
npm run test:unit         # compile, then the unit tests (fast, vscode stubbed)
npm run test:integration  # compile, then the tests in a real VS Code window
npm run lint
```

Please make sure the unit tests and the linter pass before submitting a PR, and
run the integration tests when you change key handling, commands or how a
feature is registered.

---

## Project Structure

```
src/
├── extension.ts          # Entry point — one register call per feature
├── semanticTokens.ts     # Merges the VBScript and JavaScript colouring
├── core/                 # Text rules every language shares, no vscode import:
│                         #   zones (<% %>, <script>, <style>), includes, paths,
│                         #   VBScript strings/comments, HTML tag pairing, ignore comments
├── vbscript/             # The VBScript parser, binder, checks and colouring —
│                         #   no vscode import, so it runs on worker threads and in tests
├── workers/              # Worker threads (JavaScript analysis, VBScript, colouring, includes)
├── platform/             # Shared editor services: settings, log, diagnostics,
│                         #   per-document state, the workspace file index, quick fixes
├── asp/                  # ASP/VBScript features: completion, hover, F12, rename,
│                         #   signature help, symbols, typing (Enter/Tab/auto-close)
├── html/                 # HTML completion, hover, linked editing, Emmet, links
├── css/                  # CSS completion, hover, colours, diagnostics
├── js/                   # JavaScript features over a virtual file of the page's scripts
├── formatter/            # Format Document: masks the ASP, runs Prettier, formats each block
├── constants/            # Keywords, functions, ASP objects, COM types, HTML data
└── test/                 # unit/ (mocha, vscode stubbed) and integration/ (real VS Code)
syntaxes/
└── asp.tmLanguage.json   # TextMate grammar; its name lists are generated from src/constants
snippets/                 # ASP/VBScript, HTML and JavaScript snippets
```

`npm run lint` keeps the layers apart: `core/`, `vbscript/` and `constants/`
may not import `vscode` or the feature folders.

---

## Making Changes

1. Create a branch from `main`:

   ```bash
   git checkout -b fix/your-bug-description
   # or
   git checkout -b feat/your-feature-name
   ```

2. Make your changes. Keep commits focused — one logical change per commit.

3. Test in the Extension Development Host (`Ctrl+F5`) with real `.asp` files.
   Pay particular attention to edge cases like:
   - Files with both `<%...%>` blocks and `<script>` blocks on the same page
   - Multi-line VBScript with line continuation (`_`)
   - Deeply nested `#include` chains
   - Files with `Option Explicit`

4. Run the unit tests and the linter before committing:

   ```bash
   npm run test:unit
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
- Passes `npm run test:unit` and `npm run lint` cleanly

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