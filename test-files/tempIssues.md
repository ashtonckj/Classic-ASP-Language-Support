🔴 High Impact
1. `#include virtual="..."` is only half-implemented
You resolve `file="..."` fully but `virtual="..."` only uses the first workspace folder root as a guess. In real IIS setups, the virtual root can be configured differently. Users with virtual includes will get broken Go to Definition, broken document links, and broken cross-file IntelliSense silently — no error, just nothing works.
[Done]

2. No Option Explicit awareness
You track implicit variable assignments (undeclared variables) as symbols, which means your IntelliSense suggestions get polluted with loop counters, temp variables, and typos. If the file has `Option Explicit`, you should stop tracking implicit assignments entirely and only show declared Dim/Const variables.
[Done]

3. COM object tracking is one-level deep only
If someone does this:
```vb
Set oConn = CreateObject("ADODB.Connection")
Set rs = oConn.Execute(sql)
```
`rs` won't be recognised as a `Recordset` because it wasn't created via `CreateObject` directly. Chained COM results are never typed.
[Done]

4. Formatter has no undo safety
If formatting produces an unexpected result on a complex file, there's no dry-run or preview. The entire document is replaced in one TextEdit. If something goes wrong the user has to `Ctrl + Z` carefully. A diff-based approach replacing only changed ranges would be safer and also faster on large files.
[Done] 

5. No renaming support
You have Go to Definition and IntelliSense, but no `F2` rename. Users working on large codebases with functions used across many `#include` files have no safe way to rename a function or variable across all files.
[Done] 


🟡 Medium Impact
6. Semantic tokens re-run on every keystroke
Your semantic token provider scans the full document every time. On large files (1000+ lines) this is the source of the lag fix you already did in v0.3.6 (#51), but the root cause isn't fully addressed — incremental/dirty-range token updates would be the proper fix.

7. Hover docs for user functions only show the signature
If someone writes a function without ''' <summary> doc comments, hover just shows the raw definition line. It would be more useful to also show the parameter names with their inferred usage, similar to how VS Code shows JS function hovers.

9. No multi-cursor or selection formatting
`Alt + Shift + F` always formats the whole document. Formatting only a selected region would be very useful for large legacy files where users want to clean up one section at a time without touching everything else.

9. #include depth is only one level
You resolve includes from the current file, but if header.asp includes utils.inc, the symbols in utils.inc are invisible. Cross-file IntelliSense only goes one level deep.
[Done] 

10. No workspace-wide symbol search
`F12` works per-file and its direct includes, but there's no `Ctrl + T` / workspace symbol search. On large projects with many `.asp` files users can't search for a function by name across the whole project.


🟢 Lower Impact / Quality of Life
11. Snippets have no linked tab stops on dbconn/rs
Actually you do have this (${1:conn} updating everywhere) — but the rs snippet hardcodes conn as the connection variable name rather than linking it to whatever the user named their connection. Minor but noticeable.

12. No signature help (parameter hints)
When a user types `MyFunction(` there's no tooltip showing the expected parameters. You have the parameter data already from your symbol extraction — it's just not wired up to `vscode.languages.registerSignatureHelpProvider`.

13. CSS diagnostics run on every `<style>` block rescan
When you validate CSS you re-scan the entire document for `<style>` tags on every keystroke change. Caching the last known style block positions and only re-validating dirty blocks would be cleaner.

14. No `.asp` file icon
The VS Code Marketplace and file explorer show a generic icon for .asp and .inc files. A custom file icon theme contribution would make the extension feel more polished.

15. The test suite is essentially empty
`src/test/extension.test.ts` has only a placeholder test. The formatter, region detection, and symbol extraction are all untested. Any regression introduced in a future version won't be caught automatically.

🔴 Bugs
1. `extension.ts` — wordBasedSuggestions is set globally, not per-language
```ts
aspConfig.update('wordBasedSuggestions', 'off', vscode.ConfigurationTarget.Global)
```
This silently turns off word-based suggestions for all languages in the user's editor on first activation. It should use `vscode.ConfigurationTarget.WorkspaceFolder` with a language-scoped key, or better, declare `"[asp]": { "editor.wordBasedSuggestions": "off" }` in the contributes.configurationDefaults section of `package.json` — which is the proper zero-side-effect way to do this. As it stands, a user who installs your extension will lose word suggestions in Python, JavaScript, etc.

2. `aspHoverProvider.ts` — getAspContext uses lastIndexOf which breaks on nested or multiple blocks
```ts
const lastOpen  = textBefore.lastIndexOf('<%')
const lastClose = textBefore.lastIndexOf('%>')
if (lastOpen !== -1 && lastOpen > lastClose) { return 'vbscript'; }
```
This simple heuristic can misfire on files with many ASP blocks. A file like `<% x = 1 %>` some html `<%`  will correctly return 'vbscript', but if a `%>` happens to appear in a VBScript string literal before the cursor, lastClose will overtake lastOpen and falsely return 'html', suppressing all hover docs. The correct fix is to reuse `isInsideAspBlock` from `aspUtils.ts`, which already handles strings and comments correctly — the same way getContext in `documentHelper.ts` does it.

3. `aspRenameProvider.ts` — buildAspMap doesn't skip VBScript strings or comments
The buildAspMap helper in aspRenameProvider.ts is a simplified version that just looks for raw `<% / %>` pairs without the string-literal or comment-line awareness that `isInsideAspBlock` has. This means a `%>` that appears inside a VBScript string like `Dim s = "end %>"` will prematurely close the map, causing rename to incorrectly operate on identifiers outside the ASP block. Since `isInsideAspBlock` already exists and solves this problem, `buildAspMap` should either use it or be replaced with the same logic from `aspUtils.ts`.

4. `htmlStructureDiagnosticsProvider.ts` — inScript/inStyle tracking is fragile
When the scanner hits `</script>` or `</style>`, it checks with a regex at position `i` but then does `i++` rather than advancing past the full closing tag. This means the character immediately after `</script>` re-enters the `inScript = true` path briefly on the next iteration, which can cause the scanner to miss the first character of content after a `</style>` tag. It's a minor off-by-one but can cause false diagnostics on style blocks that immediately follow a script block.

5. `aspIndentProvider.ts` — registerLineContinuationGuard is defined but never registered
The function `registerLineContinuationGuard` is exported from `aspIndentProvider.ts` but there is no corresponding `registerLineContinuationGuard(context)` call in `extension.ts`. The suppress-suggestions-on-_ feature is therefore completely non-functional. Either add the call in `extension.ts` or remove the dead export.

6. `aspCompletionProvider.ts` — `require('path')` called inline on every completion
```ts
item.detail = fromInclude 
  ? `Variable (from ${require('path').basename(v.filePath)}) : ...`
```
`require('path')` is called inline inside the hot completion loop — once per symbol per keystroke. While Node caches require calls, the pattern is still messy and inconsistent: path is already imported at the top of `includeProvider.ts` which feeds the data, and a simple `import * as path from 'path'` at the top of `aspCompletionProvider.ts` would be cleaner and more correct. More importantly, if this file is ever bundled with esbuild (your `package.json` has esbuild as a devDependency), inline `require()` calls can break the bundle.

🟠 High-Impact Improvements
7. `collectAllSymbols` has no caching — called on every keystroke by 5+ providers
`collectAllSymbols` calls `extractSymbols` + `fs.readFileSync` for every included file, every time any provider fires (hover, completion, semantic tokens, rename, definition). On a project with 10+ include files this is synchronous disk I/O on every single keystroke. A simple document-version-keyed cache (invalidated on `onDidChangeTextDocument`) would make a dramatic difference. This is the single most impactful performance improvement available.

8. Symbol extraction misses For Each loop variables and function return assignments
extractSymbols only captures `Dim/ReDim/Public/Private` declarations and implicit assignments. But VBScript `For Each item In collection` creates item as a de-facto variable, and `functionName = someValue` inside a function body is a return-value assignment, not a new variable. Users will notice that loop variables don't appear in completions or hover, especially in Option Explicit-less files.

9. No hover for inline `style=""` CSS properties
`CssHoverProvider` only covers `<style>` blocks. Users hovering over a CSS property inside `style="color: red"` get nothing. Since you already built the full inline CSS virtual document machinery in `cssUtils.ts` (`getInlineStyleContext`, `buildInlineCssDoc`), adding inline style hover is a small extension of the existing `CssHoverProvider`.

10. JS completion provider uses name-hint heuristics instead of type inference
In `jsCompletionProvider.ts`, the default branch of the object-access switch guesses the type based on variable name patterns (/arr|list/i → array methods, /str|text/i → string methods). This produces wrong completions constantly — e.g. result. on a fetch result suggesting array methods because "result" doesn't match /response|res$/. A better fallback is to show a merged list of the most commonly needed method groups, or simply show nothing and let the user type more characters.

11. `aspStructureDiagnosticsProvider.ts` — Property blocks not checked
The VBScript structure scanner checks `Sub`, `Function`, `Class`, `If`, `For`, etc., but does not check `Property Get/Property Let/Property Set` blocks, which also need `End Property` closers. These are legitimate block structures in VBScript class definitions and users who write them will see no squiggle when they forget End Property.

12. No document symbol provider (Outline view is empty)
There is no `vscode.DocumentSymbolProvider` registered, so the VS Code Outline panel shows nothing for `.asp` files. All the symbol data is already extracted in `collectAllSymbols` — a `DocumentSymbolProvider` that feeds the outline and the breadcrumb bar would be straightforward to build and is something users expect from a language extension.


🟡 Medium Improvements & Incomplete Features
13. `aspCompletionProvider.ts` — No parameter hints (signature help)
When a user types `MyFunction(`, there is no `SignatureHelpProvider`, so no tooltip appears showing the expected parameters. The data is already there in `allSymbols.functions[].params` and paramNames. A `vscode.SignatureHelpProvider` triggered on `(` and , would complete the "IntelliSense feels like a real language" experience.

14. `aspHoverProvider.ts` — No hover for built-in VBScript functions
Hovering over `Split(`, `InStr(`, `DateDiff(` etc. returns nothing. You have `VBSCRIPT_FUNCTIONS` as an array of names in `aspKeywords.ts`, but no corresponding documentation. Adding even brief MDN-style docs for the ~60 built-in functions would make the hover feature feel complete — right now it only covers keywords.

15. `formatter\htmlFormatter.ts` — No progress notification for large files
For files with many ASP blocks, formatting can take 1–3 seconds synchronously. There is no `vscode.window.withProgress` wrapper, so the user sees nothing happen and may click format again. A simple progress notification `("Formatting…")` would prevent confusion.

16. CSS diagnostics don't cover inline `style=""` attributes
`cssDiagnosticsProvider.ts` validates `<style>` blocks only. Errors in `style="colour: red"` (misspelled property) are silently ignored. The virtual document infrastructure in `cssUtils.ts` already supports inline styles for completion — validation would be a natural extension.

17. `jsCompletionProvider.ts` — No user-defined JS variable/function completions
Inside `<script>` blocks, you provide completions for all built-in JS APIs, but not for variables and functions the user has themselves declared in the same `<script>` block or in other `<script>` blocks on the page. A user who writes `function submitForm() {}` and then types sub below it gets no suggestion for their own function.

18. `package.json` — `enableHTMLCompletion` and `enableJSCompletion` settings referenced in code but not declared
Both `htmlCompletionProvider.ts` and `jsCompletionProvider.ts` read `aspLanguageSupport.enableHTMLCompletion` and `aspLanguageSupport.enableJSCompletion` respectively, but these settings are not declared anywhere in package.json's `contributes.configuration` section. They will always return undefined (which is truthy), meaning the feature flags effectively don't work — users cannot disable these providers through settings.

19. `aspRenameProvider.ts` — Rename doesn't update #include file paths
If a user renames a function that is declared in an included file, the declaration itself is updated correctly. But if the same function name appears in a third file that includes the declaration file (a transitive include), those occurrences are missed. `resolveIncludePaths` is called on the current document only, not on all files in the workspace that might include it.

20. File icon suggestion — iconTheme conflict
You mentioned this. The clean approach is to contribute a fileIcons entry within an existing `productIconTheme` or use the `contributes.iconThemes` field with a minimal theme that only adds the `.asp` icon and inherits everything else from the active theme. The con is that VS Code's icon theme API doesn't support "additive" icon themes — any icon theme you register replaces the active one entirely unless the user explicitly activates it. The practical recommendation is to skip this for v1.0.0 and document it as a known limitation, since fighting the icon theme system will frustrate users who use Seti, Material Icons, etc.

🟢 Lower Priority / Polish
21. `CHANGELOG.md` should be verified before v1.0.0
I didn't see the content of `CHANGELOG.md` — ensure it accurately reflects all features through 0.3.7 and add a v1.0.0 entry that summarizes the promotion-to-stable rationale.

22. `language-configuration.json` — ' auto-close pair should be removed
```json
{ "open": "'", "close": "'", "notIn": ["string", "comment"] }
```
In VBScript, ' is the line-comment character, not a string delimiter. Auto-closing it will insert a trailing ' every time a user types a VBScript comment, forcing them to delete it immediately. This should be removed from `autoClosingPairs` (it can stay in surroundingPairs if desired for the HTML zone).

23. `aspCompletionProvider.ts` — isAfterEnd check is too loose
The guard `if (/\bend\s+i?f?$/i.test(textBefore.trim()))` only partially suppresses snippet expansion after "End". It catches "End I" and "End If" but not "End Sub", "End Function", "End With", etc. — typing "End S" would still offer the full Sub snippet. A tighter check against all End-keyword variants would prevent noisy completions.

24. `htmlCompletionProvider.ts` — attribute completion requires at least one character after the tag name
The check `if (afterTagName && afterTagName[1].trim().length > 0)` means attributes are not suggested immediately after `<div ` (with trailing space) unless the user has already typed something. The `context.triggerCharacter === ' '` branch below it should fire in this case but the ordering means it only fires when `isInsideTagForAttributes` is true AND `getCurrentTagName` returns a value — double-checking that the space-triggered path correctly feeds through on the very first space after a tag name would be worthwhile.

25. README compatibility table — HTML CSS Support entry
The ⚠️ Caution note says it "may conflict." It would be more useful to describe the specific conflict (duplicate HTML attribute completions) and the specific workaround (disable the HTML completions in that extension's settings), so users can actually use both if they want to.

Summary of the top 3 things to fix before calling it v1.0.0, in order of severity: the global `wordBasedSuggestions` override (bug that harms every language), the `collectAllSymbols` caching (performance issue that affects the entire editing experience on real projects), and the undeclared `enableHTMLCompletion/enableJSCompletion` settings (feature flags that silently don't work). Everything else is polish or additive.
