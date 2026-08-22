# Bug repro fixtures — round 6 (fresh audit)

These are **new** findings, not carry-overs from `asp-extension-remaining-backlog.md`. Everything in the
first table was reproduced against the compiled code with a scripted probe before the fixture was written,
so these should all reproduce for you — the fixture is to let you *see* it and judge severity, not to
decide whether it's real.

Flow: press **F5** for the Extension Development Host, open the repo folder as the workspace, then open
each file. Every file carries its own step-by-step comment at the top, and almost all of them include a
**control** — the same construct without the trigger — so you can see the working case side by side.

Severity: 🔴 corrupts / blocks · 🟠 wrong-but-recoverable · 🟡 polish.

## Confirmed by probe — has a fixture

| # | File | Sev | What's wrong | Root cause |
|---|------|-----|--------------|------------|
| 01 | `01-bare-lt-blocks-formatter.asp` | 🔴 | A literal `<` in HTML prose (`Total: 5 < 10`) produces a false "Missing closing tag" — **and Format Document then refuses to run** | `htmlStructureDiagnosticsProvider.ts` `scanHtmlStructure`: any `<` starts a tag and is scanned to the next `>`, swallowing the real `</div>` |
| 02 | `02-rename-partial-apostrophe.asp` | 🔴 | F2 **silently skips** occurrences on lines whose HTML part contains an apostrophe → half-renamed file | `aspRenameProvider.ts` `findAllOccurrences` → `isInStringOrComment(lineSlice)` reads the physical line from column 0, so `it's` in HTML reads as a VBScript comment |
| 03 | `03-rename-vbscript-script-block.asp` | 🟠 | F2 inside `<script language="vbscript">` opens the rename box, then does nothing at all | `buildAspMap` maps only `<% %>`, but `prepareRename` accepts any `getZone === 'asp'` |
| 04 | `04-apostrophe-kills-intellisense.asp` | 🟠 | On a mixed HTML+ASP line, an apostrophe or a single-quoted attribute kills completion, Ctrl+Click **and** hover for the rest of the line | `isInsideVbStringOrComment(fullLine, col)` called with the whole line — `aspCompletionProvider.ts:41`, `aspDefinitionProvider.ts:40`, plus `aspHoverProvider.ts`'s own copy of the scan (lines 217-227 and 317-319) |
| 05 | `05-dim-colon-loses-variable.asp` | 🟠 | `Dim x : x = 1` — an everyday ASP one-liner — loses the variable **entirely** (no completion, no hover, no go-to-def, rename refused) | `includeProvider.ts` `extractSymbols`: the `Dim` regex captures to end-of-line and never splits on `:` |
| 06 | `06-attr-completion-after-gt.asp` | 🟠 | HTML attribute IntelliSense stops working for a tag once any attribute value contains a literal `>` | `documentHelper.ts` `isInsideTagForAttributes` / `getCurrentTagName` use naive `lastIndexOf('<')` vs `lastIndexOf('>')` |
| 07 | `07-bare-lt-kills-js-css-zone.asp` | 🟠 | Same `<`-in-prose trigger as 01, on the zone resolver: the following `<script>`/`<style>` is never recognised, so all JS and CSS features go dead | `zoneUtils.ts` `findNextRealTag`: a `<` sets `inHtmlTag`, and the `inHtmlTag` branch doesn't re-check for `<` |
| 08 | `08-continuation-declarations.asp` | 🟡 | Declarations split over a trailing `_` are misread: `Function Add( _ / a, _ / b)` gets **no parameters**, and `Dim total, _` registers a variable literally named `_` | `extractSymbols` is per-physical-line; it never joins continuations (the structure diagnostics provider already has a `joinContinuationLines` for exactly this) |
| 09 | `09-signature-help-in-comment.asp` | 🟡 | Parameter hints pop up over commented-out calls | `aspSignatureHelpProvider.ts` `findActiveCall` skips strings but not `'` comments |
| 10 | `10-goto-def-unsaved-include.asp` + `10-goto-def-lib.inc` | 🟡 | Go-to-def into an **unsaved** include lands on the wrong column | `aspDefinitionProvider.readLine` reads the include from disk while `collectAllSymbols` read it from the buffer. `readIncludeText()` already exists — this is the same fix as commit `79b0430` did for rename, not yet applied here |
| 11 | `11-phantom-com-var-in-comment.asp` | 🟡 | A commented-out `Set x = Server.CreateObject(...)` still registers a typed COM variable | `extractSymbols`' CreateObject pass runs on the raw line (correct — the ProgID is in a string) but never strips a trailing comment |
| 12 | `12-root-relative-links.asp` + `12-link-target.asp` | 🟡 | Root-relative `href="/…"` never underlines, and its path completion browses the **drive root** | `linkProvider.ts` uses `path.resolve(docDir, value)` and ignores `getVirtualRoot()`, which `#include virtual=` already uses |

**01 and 07 are the same underlying defect** (`<` in text treated as a tag opener) in two different scanners.
**02, 04 and part of 10** are all "a line-local scan started at column 0 of a mixed HTML/ASP line".
Worth fixing as shared helpers rather than one site at a time.

## Second pass — editor behaviour, formatting, outline, config

A follow-up sweep over the parts the first pass didn't reach: the typing handlers, the formatter's edit
builder, the outline, the region highlighter, and the activation path.

| # | File | Sev | What's wrong | Root cause |
|---|------|-----|--------------|------------|
| 13 | `13-format-crlf.asp` + `13b-format-lf.asp` | 🟠 | On a **CRLF** file, Format Document rewrites the **whole document** even when one line changed — losing the "only changed lines are touched" behaviour, jumping the caret, and marking every line dirty in the gutter and source control | `aspLanguageSupport.prettier.endOfLine` defaults to `lf`, so Prettier's output has no `\r`; `computeLineEdits` ([extension.ts:35](../../src/extension.ts:35)) then splits on `\n` and sees `\r`-terminated originals vs clean formatted lines, so every line compares unequal. Probe: 6 of 7 lines reported as changed for a 1-line change. Defaulting the setting to `auto` fixes both halves |
| 14 | `14-autoclose-inside-vbscript-string.asp` | 🟠 | Typing `Response.Write "<div>"` auto-inserts `</div>` **inside the VBScript string**. Fires on `<table>`, `<tr>`, `<td>`, … — i.e. constantly, since that's how you build HTML in ASP | The `>` branch of `registerAutoClosingTag` ([aspIndentProvider.ts:580](../../src/providers/aspIndentProvider.ts:580)) never calls `getZone` (the HTML-comment branch right above it does). Its attribute-value guard is `lastRealTagOpen !== -1 && inQuote !== null`, and inside a VBScript string there is no tag opener, so `lastRealTagOpen` is `-1` and the guard is skipped. Same branch also injects `</div>` after a hand-written `<div />` |
| 15 | `15-indent-unit-mismatch.asp` | 🟡 | Enter/Tab indent by the **editor's** tab size (4 by default); Format Document re-indents to `prettier.tabWidth` (2 by default). Out of the box, typing and formatting disagree | `getIndentUnit` ([aspIndentProvider.ts:92](../../src/providers/aspIndentProvider.ts:92)) reads `editor.options.tabSize`, while `getAspSettings` ([aspFormatter.ts:13](../../src/formatter/aspFormatter.ts:13)) reads `aspLanguageSupport.prettier.tabWidth` |
| 16 | `16-stale-region-highlight.asp` | 🟡 | Delete the last `<% %>` block and its background tint **stays painted** over the HTML that moved up. Survives further typing; only fixed by switching editors | `updateDecorations` ([highlight.ts:84](../../src/highlight.ts:84)) does `if (!regions \|\| regions.length === 0) return;` before ever calling `setDecorations`, so the previous ranges are never cleared |
| 17 | `17-outline-class-members.asp` | 🟡 | Outline is flat: a Class's `Sub`/`Property` members are siblings of the Class, with ranges **inside** the Class's range (invalid per the `DocumentSymbol` contract); breadcrumbs don't show `Cart > Add`. Plain `Dim` variables never appear at all, though the provider's header comment says they do | `aspDocumentSymbolProvider.ts` never populates `DocumentSymbol.children`, and emits no entries for `symbols.variables`. Verified against the fixture: `Cart` 28-36 with `Add` 30-32 and `Count` 33-35 returned as siblings, `children.length === 0` on all five symbols |
| 18 | `18-inline-css-inside-js-string.asp` | 🟡 | A `style="…"` written inside a **JavaScript string** gets pulled out and validated as CSS, producing warnings on JS code | `cssDiagnosticsProvider.ts:148` skips zone `'css'` and `'asp'` but not `'js'` |
| 19 | `19-format-diagnostics-race.asp` | 🟡 | Format Document's "structure issues found" gate reads a **1500 ms debounced** cache, so it formats a broken file if you're quick and refuses a just-fixed one for 1.5 s | `getStructureIssueCount` ([extension.ts:68](../../src/extension.ts:68)) reads the diagnostic collections instead of running the scan at format time |

### Second pass — no fixture

- 🟠 **Activation can fail outright next to another extension that owns `type`.**
  `registerSmartQuoteHandler` calls `vscode.commands.registerCommand('type', …)`
  ([aspIndentProvider.ts:1158](../../src/providers/aspIndentProvider.ts:1158)) with no `try`/`catch`, and
  `activate()` calls it bare ([extension.ts:343](../../src/extension.ts:343)). VS Code allows only one
  `type` handler; VSCodeVim and similar extensions register it. If they win the race, `registerCommand`
  throws, `activate()` throws — and because the throw happens *before* the final
  `context.subscriptions.push(...)`, every provider registered above it is also left unregistered for
  disposal. I have not reproduced this against a real Vim install; the single-owner rule and the missing
  guard are both plain in the code. Cheap fix regardless: wrap it, and fall back to no smart-quote.
- 🟡 **`_styleTimeout` / `_attrPathTimeout` are module-level and never cleared on deactivate**
  ([extension.ts:110](../../src/extension.ts:110)) — a pending `triggerSuggest` can fire after teardown.
- 🟡 **Region highlighting churns while switched off.** With `highlightAspRegions: false`,
  `updateDecorations` still disposes and re-creates both `TextEditorDecorationType`s on every 200 ms
  tick, for a feature that is disabled.
- 🟡 **Inline-CSS validation is O(lines × document).** It calls `getZone` (a full-document scan) once per
  `style=` occurrence, so a page with a few hundred inline styles re-scans the document a few hundred
  times per validation pass. Same family as the perf items already in the backlog.
- 🟡 **`asp.insertTab`'s keybinding lacks `!inSnippetMode`,** which the `enter` binding does have. In
  practice the handler falls through to the built-in `tab` for non-blank lines so I could not construct a
  failing case — flagging the inconsistency, not a confirmed defect. Worth a one-word fix while you're
  in `package.json`.

### Checked in the second pass and found clean

- **Settings contributions.** All 20 settings the code reads are declared in `package.json` — including
  the whole `aspLanguageSupport.prettier.*` group — with sensible enums and descriptions. Nothing
  undeclared, nothing declared-but-unread. (`endOfLine` already offers `auto`; it's only the *default*
  that causes #13.)
- **`registerEnterKeyHandler` / `registerTabKeyHandler`** both bail correctly on multi-cursor, and their
  keybindings correctly exclude `suggestWidgetVisible` / `renameInputVisible` / inline-suggestion states.
- **`findAspRegionOffsets`** pairs each `<%` with its first `%>` lexically — correct per the engine rule,
  and a stray `%>` in HTML text no longer shifts every later block.
- **Debounce + disposal hygiene** in the three diagnostics providers: per-URI timers, cleared on close and
  on deactivate, collections disposed via `context.subscriptions`.
- **The `>`-auto-close attribute guard does work** for its intended case (`<a href="<"` correctly does not
  auto-close) — #14 is specifically the no-tag-opener path.

## Confirmed by probe — no fixture (not visible by opening a file)

- 🟡 **A VBScript string containing `<!--` swallows every declaration until the next `-->`.**
  `extractSymbols` strips HTML comments with a plain regex before parsing, ignoring VBScript strings.
  Probe: `s = "<!-- x"` / `Dim afterwards` / `s2 = "-->"` → `afterwards` is missing from the symbol list.
- 🟡 **`~/` in `aspLanguageSupport.virtualRoot` is broken on Windows.** `getVirtualRoot` expands via
  `process.env.HOME`, which Windows doesn't set (it's `USERPROFILE`), and the fallback produces a
  nonsense doubled path rather than failing cleanly.
- 🟡 **Dead / wasteful code:** `scanHtmlStructure` builds `const lines = fullText.split('\n')` and never
  uses it (a full copy of the document per scan); `aspRenameProvider.countNewlines` is O(n) per match,
  making rename O(n·matches) on large files.

## Design question, not a defect — needs your call

- **Rename rewrites every `.asp`/`.inc` in the workspace**, not just files in the include graph
  (`aspRenameProvider.provideRenameEdits`, the `workspaceFiles` loop). Renaming a global `Dim total` on
  one page rewrites `total` in completely unrelated pages that never include it. The code comment says
  this is for symbols reachable "transitively", but there's no reachability check. Classic ASP has no
  module system, so a case can be made either way — tell me whether you want it narrowed to the include
  graph (plus files that include the declaring file) or left as a workspace-wide rename.

## Checked and found clean (so we don't re-audit these)

- **Formatter round-trip.** `formatCompleteAspFile` is idempotent on all five existing `test-files/*.asp`
  and on nine hand-built edge cases (`%>` inside a VBScript string, ASP inside attribute values, ASP
  loops around `<tr>`/`<option>`, includes, `<script>`/`<style>` blocks). No corruption, no drift.
- **VBScript structure classification.** `classifyLine` was right on all 14 edge cases thrown at it
  (`Dim withdrawal`, `s = "with love"`, `For i = 1 To 10 : Next`, `Exit Do`, `On Error Resume Next`,
  single-line `If … Then …`, `ReDim Preserve arr(10)`, …).
- **`getInlineStyleContext`** handles a `>` in an earlier attribute, an ASP expression inside the value,
  and two `style=` attributes on one line.
- **HTML structure diagnostics** are correct on `&lt;`, on `<` followed by a real tag before the closer,
  on unquoted attribute values ending in `<%= x %>`, and on ASP conditionals wrapping markup.

## After you've confirmed

Tell me which of 01–19 reproduce and I'll fix them one at a time, each with a unit test and its own
commit. Suggested order (severity, and shared root causes grouped so one fix closes several fixtures):

1. **01 + 07** — one lexical fix for `<`-in-text, applied to both scanners. Unblocks the formatter.
2. **02 + 04 (+ 10)** — a shared "scan this line starting at the ASP block, not column 0" helper.
3. **14** — add the missing `getZone` guard to the `>` auto-close branch. One line, stops the extension
   corrupting `Response.Write` strings as you type.
4. **13** — change the `endOfLine` default to `auto`. One line, fixes whole-file rewrites on Windows.
5. **03** — teach `buildAspMap` about VBScript `<script>` blocks.
6. **05 + 08 + 11** — the `extractSymbols` cluster (colon splitting, continuation joining, comment strip).
7. **06** — reuse the zone/attribute-aware scanner in `documentHelper`.
8. **17, 16, 18, 19, 15, 09, 12**, then the no-fixture batches.

Note 3 and 4 are one-line fixes with outsized impact — worth doing first if you want quick wins.
