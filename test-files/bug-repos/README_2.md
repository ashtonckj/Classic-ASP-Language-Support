# Bug repro fixtures — round 5 (the remaining backlog)

Same flow: F5 into the Extension Development Host and open these. Each file has exact steps.
Several here are **subtle** or **minor** — I've marked those, and if any don't reproduce for you, say so
and I'll drop them (like W/X/H earlier).

## Observable — has a fixture

| # | File | What | How to see it | Note |
|---|------|------|---------------|------|
| 01 | `01-goto-def-wrong-occurrence.asp` | Go-to-def lands on the first substring (`count` in `accountCount`) | Ctrl+Click `count` | clear |
| 02 | `02-signature-help-param-count.asp` | Active param miscounted when an arg string has a comma | caret after `"a, b",` | clear |
| 03 | `03-operator-spacing.asp` | Format: `\` `^` not spaced; trailing `&` (Long) wrongly spaced | Format Document | minor/cosmetic except `100&` |
| 04 | `04-const-colon-type.asp` | `Const URL="http://…"` typed `any` (value truncated at `:`) | hover the `<%= %>` values | subtle |
| 05 | `05-vbscript-attr-offset.asp` | `<script language="vbscript">` body offset can land in an attribute | open, watch colouring | subtle edge |
| 06 | `06-inline-style-gt-in-value.asp` | inline `style=""` ends at a `>` inside the value → no CSS help | Ctrl+Space in the value | rare edge |
| 07 | `07-script-close-in-string.asp` | `getZone` vs `getJsRanges` disagree on `</script>` in a JS string | JS features on `alert(1)` | subtle |
| 08 | `08-hover-doubled-quote-comment.asp` | hover comment-split mishandles `""` escape | hover `Then` | subtle |
| 09 | `09-rename-main.asp` + `09-rename-lib.inc` | rename reads includes from disk, not the open buffer | needs an **unsaved** edit in the .inc | fiddly setup |
| 10 | `10-sql-concatenation.asp` | SQL built from `&`/variables isn't fully coloured (recall) | open, compare the two | the big one |

## Not observable — no fixture (verified by test, or only shows on scale)

These are real but can't be "seen" by opening a file:

- **Performance (large files only):** the ASP semantic provider ignores cancellation and rescans O(n²);
  HTML structure diagnostics `slice` per character; the JS projection re-runs 2–5× per keystroke. You'd
  only feel these as lag on a very large `.asp`. I'll verify fixes with timing, not a fixture.
- **`asp-dom.d.ts` never loads at runtime** (wrong path → always the inline fallback). Internal; the fix
  is verified by checking the loaded path, not by eye.
- **Formatter internals:** `maskJsEventAttrs` isn't zone-aware (masks `on*=` inside VBScript strings/JS);
  `hasUnclosedAspTags` uses slightly different lexical logic than the masker (only differs on a
  `%>`-inside-a-string edge). Both survive normal round-trips, so there's nothing to see — unit tests cover them.
- **Cleanup:** ~13 stale compiled files in `out/`; a couple of dead code spots; the CSS provider arms a
  debounce timer for every document; a duplicate blank logical line in continuation joining.

## Dropped from the earlier list

- **"Extend the table normalizer to `<li>`/`<option>`/`<p>`/`<dt>`":** checked — Prettier already handles
  those implied end tags correctly. It only mis-nested the table family, which is already fixed. Nothing to do.
- **"Finish AA across the other SQL passes":** those passes are SQL-variable tracking / diagnostics, not the
  primary colouring, so their fix folds into the SQL **recall** work (#10) rather than a separate bug.

## After you've confirmed
Tell me which of 01–10 reproduce. Then I'll fix the confirmed ones one at a time with tests (01, 02, 03,
04, 06, 08 are unit-testable; 05/07/09/10 need more care). The non-observable batch I can do whenever —
it doesn't need your F5 verification.
