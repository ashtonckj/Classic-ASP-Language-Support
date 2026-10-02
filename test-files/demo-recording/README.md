# Re-recording the README demo GIF

`images/demo.gif` and `images/social-preview.png` are made by these scripts.
They drive a real VS Code window, so every frame is a real screenshot of the extension, not a mock-up.

How it works:

1. `rec/record.mjs` launches an **isolated** VS Code from `.vscode-test/` with its own profile in `vsc/`.
   Your own VS Code, settings and extensions are untouched.
2. It records the window continuously over the Chrome DevTools Protocol while it types,
   clicks and presses keys:
   - Format Document
   - `rs.` IntelliSense
   - a missing `Set` and its quick fix
   - an F2 rename
   - the same page in four themes

   Mouse moves are real and eased, so hover effects match. Every move, click and caption
   goes into a timeline (`rec/cast.json`), along with where the code and popups were at that
   moment.
3. `rec/make_gif.py` renders the GIF at 25 fps. It draws the pointer and the click ripples,
   places each caption next to the action where it covers no code or popup, and cross-fades
   the format and theme changes. It plays the wait for the missing-`Set` squiggle four times
   faster, then adds the end card.
4. `rec/social.py` builds the 1280×640 share image from the last frame (the finished page in Catppuccin Mocha).

## One-time setup

The profile needs the extension and the Catppuccin theme. Run these from the repo folder:

```bash
mkdir -p test-files/demo-recording/vsc/ext
cp -r ~/.vscode/extensions/catppuccin.catppuccin-vsc-* test-files/demo-recording/vsc/ext/
npm run compile && npx @vscode/vsce package
.vscode-test/vscode-win32-x64-archive-1.139.1/bin/code.cmd --user-data-dir test-files/demo-recording/vsc/ud --extensions-dir test-files/demo-recording/vsc/ext --install-extension classic-asp-language-support-X.Y.Z.vsix
```

If `.vscode-test` holds a newer VS Code, change the version in `rec/cdp.mjs` (`CODE`) and in the command above.

## Recording

```bash
cd test-files/demo-recording/rec
node record.mjs
python make_gif.py ../../../images/demo.gif
python social.py ../../../images/social-preview.png
```

A VS Code window appears for about 50 seconds. Don't type into it or move the mouse over it while it records.
Close it afterwards: the scripts leave it open. Everything a run creates is listed in `.gitignore`.

## Changing it

- **The page:** `demo/products.orig.asp`. Keep its formatted form at 35 lines or fewer, or it won't fit the 800 px window.
- **The story:** `rec/record.mjs`, one block per scene.
  - `caption(parts, anchor)` shows a caption near `anchor`, as text, keys and a sub-label: `text('…')`, `key('F2')`, `plus`, `{ sub: '…' }`.
  - `hideCaption()` clears it.
  - `moveTo(x, y, ms)` glides the pointer and `click()` clicks.
  - `crossfade(ms)` blends into the next change on screen.
- **Speed:** the `sleep(...)` after each caption is how long it stays up. `FAST` in `make_gif.py`
  sets how much faster a wait marked with `log({ type: 'fast', on: true/false })` plays.
- **Themes:** the list in scene 5 of `record.mjs`. The names are the ones the theme picker shows.
- **End card:** `end_card()` in `make_gif.py`. Once the extension is on Open VSX, it can say
  "Free on the VS Code Marketplace and Open VSX".
- **Font and editor look:** `vsc/ud/User/settings.json`.

Needs Node 22+ (for the built-in WebSocket) and Python with Pillow.
