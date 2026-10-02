# Re-recording the README demo GIF

`images/demo.gif` and `images/social-preview.png` are made by these scripts.
They drive a real VS Code window: the frames are real screenshots of the extension, not a mock-up.

How it works:

1. `rec/record.mjs` launches an **isolated** VS Code from `.vscode-test/` with its own
   profile in `vsc/`, so your own VS Code, settings and extensions are untouched.
2. It drives that VS Code over the Chrome DevTools Protocol: keystrokes go in and
   screenshots come out. The steps are Format Document, `rs.` IntelliSense, a
   missing `Set` with its quick fix, and an F2 rename.
3. `rec/make_gif.py` adds the caption bar, the cross-fade and the end card, then writes the GIF.
4. `rec/social.py` builds the 1280×640 share image from one of the frames.

## One-time setup

The profile needs the extension and the Catppuccin theme installed. Run these from the repo folder:

```bash
mkdir -p test-files/demo-recording/vsc/ext
cp -r ~/.vscode/extensions/catppuccin.catppuccin-vsc-* test-files/demo-recording/vsc/ext/
npm run compile && npx @vscode/vsce package
.vscode-test/vscode-win32-x64-archive-1.139.1/bin/code.cmd --user-data-dir test-files/demo-recording/vsc/ud --extensions-dir test-files/demo-recording/vsc/ext --install-extension classic-asp-language-support-X.Y.Z.vsix
```

If the `.vscode-test` folder holds a newer VS Code, change the version in
`rec/cdp.mjs` (`CODE`) and in the command above.

## Recording

```bash
cd test-files/demo-recording/rec
rm -rf ../vsc/ud/Backups
node record.mjs
python make_gif.py ../../../images/demo.gif
python social.py ../../../images/social-preview.png
```

A VS Code window appears for about 40 seconds. Don't type into it while it records.
Close it afterwards. The scripts don't close it themselves.

## Changing it

- **The page:** `demo/products.orig.asp`. Keep its formatted form at 35 lines or fewer, or it won't fit the 800 px window.
- **Captions and end card text:** `CAPTIONS` and `end_card()` in `make_gif.py`. Once the
  extension is on Open VSX, the end card can say "Free on the VS Code Marketplace and Open VSX".
- **Timing:** each `frame(ms)` call in `record.mjs` is one GIF frame shown for `ms` milliseconds.
- **Theme and font:** `vsc/ud/User/settings.json`.

Needs Node 22+ (for the built-in WebSocket) and Python with Pillow.
