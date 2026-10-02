// Records the README demo: real VS Code, real extension, frames over CDP.
import fs from 'node:fs';
import { launch, sleep, S } from './cdp.mjs';

const OUT = `${S}/rec/frames`;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(`${S}/demo/products.orig.asp`, `${S}/demo/products.asp`);

const v = await launch(`${S}/demo/products.asp`);
const frames = [];
let scene = 'intro';
async function frame(ms) {
    const file = `${OUT}/${String(frames.length).padStart(4, '0')}.png`;
    await v.shot(file);
    frames.push({ file, ms, scene });
}
async function type(text, ms = 70) {
    for (const ch of text) { await v.typeChar(ch); await sleep(25); await frame(ms); }
}
const maxLine = () => v.evaluate(`[...document.querySelectorAll('.line-numbers')].map(e=>+e.textContent).reduce((a,b)=>Math.max(a,b),0)`);
const visible = sel => v.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden'; })()`);
async function waitFor(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) { return true; } await sleep(100); }
    return false;
}
async function goToLine(n) {
    await v.press('ctrl+G');
    await sleep(300);
    for (const ch of String(n)) { await v.typeChar(ch); }
    await sleep(150);
    await v.press('Enter');
    await sleep(250);
}

// Let the semantic colouring (SQL in strings, ASP regions) arrive.
await sleep(9000);
await v.click(600, 760);
await sleep(200);
await v.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, modifiers: 2 });
await v.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, modifiers: 2 });
await sleep(1500);

// ── 1. Format Document ───────────────────────────────────────────────────────
scene = 'before';
await frame(1800);
scene = 'format';
await v.press('alt+shift+F');
if (!await waitFor(async () => await maxLine() >= 30)) { throw new Error('format did not happen'); }
await sleep(2500);   // colours settle on the new text
await frame(2600);

// ── 2. COM IntelliSense ──────────────────────────────────────────────────────
scene = 'intellisense';
await goToLine(30);
await v.press('End');
await sleep(150);
await v.press('Enter');
await sleep(300);
await frame(300);
await type('rs');
await v.typeChar('.');
await waitFor(() => visible('.suggest-widget .monaco-list-row'));
await sleep(500);
await frame(1500);
await type('Cl', 220);
await sleep(300);
await frame(500);
await v.press('Enter');
await sleep(300);
await frame(700);

// ── 3. Missing Set ───────────────────────────────────────────────────────────
scene = 'missingset';
await v.press('Enter');
await sleep(250);
await type('rs = conn.Execute(sql)', 55);
await waitFor(() => visible('.squiggly-warning, .squiggly-error, .squiggly-info'), 6000);
await sleep(600);
await frame(1300);
await v.press('ctrl+.');
await waitFor(() => visible('.action-widget'), 4000);
await sleep(400);
await frame(1500);
await v.press('Enter');
await sleep(1200);
await frame(1300);

// ── 4. Rename ────────────────────────────────────────────────────────────────
scene = 'rename';
await goToLine(8);
await v.press('Home');
for (let i = 0; i < 5; i++) { await v.press('Right'); }
await sleep(200);
await v.press('F2');
await waitFor(() => visible('.rename-box input, .rename-box .rename-input'), 4000);
await sleep(400);
await frame(700);
await type('products', 90);
await frame(500);
await v.press('Enter');
await sleep(1500);
scene = 'renamed';
await frame(2400);

fs.writeFileSync(`${S}/rec/frames.json`, JSON.stringify(frames, null, 1));
console.log('frames', frames.length);
process.exit(0);
