# Security Policy

## Supported Versions

Only the latest published version of Classic ASP Language Support receives
security fixes. Please update to the latest version before reporting an issue.

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |
| Older   | ❌        |

---

## Scope

This extension processes `.asp` and `.inc` files on your local machine. The
relevant attack surface is limited to:

- **Malicious `.asp` files** that could cause the formatter, diagnostic scanner,
  or symbol extractor to crash, hang, or consume excessive memory/CPU
- **Malicious `#include` paths** that could cause unexpected file system access
  outside the project directory
- **Denial-of-service via pathological inputs** (e.g. deeply recursive include
  chains, extremely large files)

**Out of scope:**

- Security of your IIS server or the Classic ASP application you're developing —
  this extension is a development tool and does not affect your running server
- Vulnerabilities in third-party dependencies (Prettier, vscode-css-languageservice)
  — please report those upstream
- VS Code itself — report those to Microsoft

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's built-in **[Private Security Advisory](https://github.com/ashtonckj/Classic-ASP-Language-Support/security/advisories/new)**
feature to report vulnerabilities privately. This ensures the issue can be
assessed and a fix prepared before any public disclosure.

When reporting, please include:

- A description of the vulnerability and its potential impact
- A minimal example file (`.asp` or `.inc`) that demonstrates the issue
- Your VS Code version and extension version
- Steps to reproduce

---

## Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | Within 5 business days |
| Initial assessment | Within 10 business days |
| Fix or mitigation | Dependent on severity |

This is a solo-maintained open source project. Response times are best-effort
and may vary. Critical issues will be prioritised.

---

## Disclosure Policy

Once a fix is released, the vulnerability will be disclosed publicly via a
GitHub Security Advisory. Reporters who wish to be credited in the advisory
are welcome to include their preferred name or handle in the report.