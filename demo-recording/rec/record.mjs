// Records the README demo as a continuous screencast of a real VS Code window,
// with a timeline of pointer moves, clicks and captions for make_gif2.py.
import fs from 'node:fs';
import { launch, sleep, S } from './cdp.mjs';

const OUT = `${S}/rec/cast`;
const SETTINGS = `${S}/vsc/ud/User/settings.json`;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(`${S}/vsc/ud/Backups`, { recursive: true, force: true });
fs.copyFileSync(`${S}/demo/products.orig.asp`, `${S}/demo/products.asp`);

function setTheme(name) {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    s['workbench.colorTheme'] = name;
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}
setTheme('Default Dark Modern');

const v = await launch(`${S}/demo/products.asp`, { height: 840 });

// ── In-page helpers: where text, the caret and the popups are ──────────────────
const HELPERS = `window.__demo = window.__demo || {
  lineEl(n) {
    const num = [...document.querySelectorAll('.margin-view-overlays .line-numbers')].find(e => e.textContent.trim() === String(n));
    if (!num) return null;
    const top = num.getBoundingClientRect().top;
    return [...document.querySelectorAll('.view-lines .view-line')].find(l => Math.abs(l.getBoundingClientRect().top - top) < 3) || null;
  },
  rangeFor(el, a, b) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let pos = 0, node, started = false;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (!started && a < pos + len) { r.setStart(node, a - pos); started = true; }
      if (started && b <= pos + len) { r.setEnd(node, b - pos); return r; }
      pos += len;
    }
    return null;
  },
  find(n, text) {
    const el = this.lineEl(n); if (!el) return null;
    const i = el.textContent.replace(/\\u00a0/g, ' ').indexOf(text); if (i < 0) return null;
    const rc = this.rangeFor(el, i, i + text.length).getBoundingClientRect();
    return { x: rc.left, y: rc.top, w: rc.width, h: rc.height };
  },
  lineEnd(n) {
    const el = this.lineEl(n); if (!el) return null;
    const r = document.createRange(); r.selectNodeContents(el);
    const rc = r.getBoundingClientRect(), lr = el.getBoundingClientRect();
    return { x: rc.width ? rc.right : lr.left, y: lr.top + lr.height / 2 };
  },
  rect(sel, text) {
    const els = [...document.querySelectorAll(sel)].filter(e => getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' && (!text || e.textContent.includes(text)));
    const vis = els.map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
    return vis.length ? { x: vis[0].left, y: vis[0].top, w: vis[0].width, h: vis[0].height } : null;
  },
  obstacles() {
    const out = [];
    for (const l of document.querySelectorAll('.view-lines .view-line')) {
      if (!l.textContent.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(l);
      const rc = r.getBoundingClientRect();
      if (rc.width) out.push([rc.left, rc.top, rc.width, rc.height]);
    }
    for (const sel of ['.suggest-widget', '.action-widget', '.rename-box', '.monaco-hover', '.notification-toast', '.quick-input-widget']) {
      for (const e of document.querySelectorAll(sel)) {
        const rc = e.getBoundingClientRect();
        if (rc.width && rc.height && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none') out.push([rc.left, rc.top, rc.width, rc.height]);
      }
    }
    const ed = document.querySelector('.monaco-editor .overflow-guard').getBoundingClientRect();
    const gutter = document.querySelector('.monaco-editor .margin').getBoundingClientRect();
    return { rects: out, area: [gutter.right + 8, ed.top + 6, ed.right - 24, ed.bottom - 6] };
  },
};`;
async function at(fn, ...args) {
    const expr = `${HELPERS}; JSON.stringify(window.__demo.${fn}(${args.map(a => JSON.stringify(a)).join(',')}))`;
    const r = await v.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) { throw new Error(`${fn}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); }
    return JSON.parse(r.result.value);
}

// ── Timeline ───────────────────────────────────────────────────────────────────
const timeline = [];
let pointer = { x: 900, y: 420 };
const log = ev => timeline.push({ t: Date.now(), ...ev });
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

async function moveTo(x, y, dur = 700) {
    const from = { ...pointer };
    log({ type: 'move', from, to: { x, y }, dur });
    const start = Date.now();
    for (;;) {
        const k = Math.min(1, (Date.now() - start) / dur);
        const e = ease(k);
        await v.mouseMove(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
        if (k >= 1) { break; }
        await sleep(16);
    }
    pointer = { x, y };
}
async function click() {
    log({ type: 'click', at: { ...pointer } });
    await v.click(pointer.x, pointer.y);
}
async function caption(parts, anchor) {
    log({ type: 'caption', parts, anchor, obstacles: await at('obstacles') });
}
const hideCaption = () => log({ type: 'caption', parts: null });
const crossfade = (dur = 260) => log({ type: 'xfade', dur });

async function type(text, ms = 85) {
    for (const ch of text) { await v.typeChar(ch); await sleep(ms + Math.round((Math.random() - 0.5) * 30)); }
}
async function waitFor(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) { return true; } await sleep(60); }
    return false;
}
const maxLine = () => v.evaluate(`[...document.querySelectorAll('.line-numbers')].map(e=>+e.textContent).reduce((a,b)=>Math.max(a,b),0)`);
const visible = sel => at('rect', sel).then(r => !!r);
const key = k => ({ k });
const plus = { plus: true };
const text = s => ({ s });

// Let the semantic colouring (SQL in strings, ASP regions) arrive.
await sleep(9000);
await v.mouseMove(pointer.x, pointer.y);

let frameNo = 0;
const frames = [];
await v.startScreencast((png, t) => {
    const file = `${OUT}/${String(frameNo++).padStart(5, '0')}.png`;
    fs.writeFileSync(file, png);
    frames.push({ file, t });
});
await sleep(300);
log({ type: 'pointer', at: { ...pointer } });
const t0 = Date.now();

// ── 1. Format Document ─────────────────────────────────────────────────────────
await caption([text('A messy Classic ASP page')], await at('lineEnd', 4));
await sleep(1500);
let end = await at('lineEnd', 17);
await moveTo(end.x + 40, end.y, 900);
await click();
await sleep(250);
await caption([key('Alt'), plus, key('Shift'), plus, key('F'), text('Format Document')], pointer);
await sleep(900);
crossfade(320);
hideCaption();
await v.press('alt+shift+F');
if (!await waitFor(async () => await maxLine() >= 30)) { throw new Error('format did not happen'); }
await sleep(500);
await caption([text('VBScript, HTML and CSS, all tidied')], await at('lineEnd', 16));
await sleep(2000);

// ── 2. COM IntelliSense ────────────────────────────────────────────────────────
hideCaption();
end = await at('lineEnd', 31);
await moveTo(end.x + 24, end.y, 900);
await click();
await sleep(250);
// Hand off the mouse, so it covers neither the typing nor the suggestions.
const away = moveTo(880, end.y - 90, 700);
await v.press('End');
await v.press('Enter');
await sleep(300);
await type('rs', 120);
await away;
await v.typeChar('.');
await waitFor(() => visible('.suggest-widget .monaco-list-row'));
await sleep(350);
end = await at('lineEnd', 32);
await caption([key('rs.'), text('Knows every ADODB.Recordset member')], end);
await sleep(1600);
await type('Cl', 200);
await sleep(450);
await v.press('Enter');
await sleep(500);
hideCaption();

// ── 3. Hover docs and Go to Definition into the include ───────────────────────
const fp = await at('find', 27, 'FormatPrice');
const fpRight = { x: fp.x + fp.w, y: fp.y + fp.h / 2 };
await moveTo(fp.x + fp.w * 0.4, fp.y + fp.h / 2, 900);
await waitFor(() => visible('.monaco-hover'), 4000);
await sleep(250);
await caption([text('Hover docs, even for code in an #include')], fpRight);
await sleep(1700);
await caption([key('Ctrl'), plus, key('Click'), text('Go to Definition')], fpRight);
await v.keyDown('Control');
await v.mouseMove(pointer.x, pointer.y, 2);
await sleep(900);
hideCaption();
crossfade(280);
log({ type: 'click', at: { ...pointer } });
await v.click(pointer.x, pointer.y, 2);
await v.keyUp('Control');
await waitFor(() => v.evaluate('document.title').then(t => /helpers\.asp/.test(t)), 4000);
await sleep(500);
await moveTo(700, 300, 600);
await caption([text('Jumps into helpers.asp, right to the Function')], await at('lineEnd', 3));
await sleep(1900);
hideCaption();
crossfade(280);
await v.press('alt+Left');
await waitFor(() => v.evaluate('document.title').then(t => /products\.asp/.test(t)), 4000);
await sleep(500);

// ── 4. Rename ──────────────────────────────────────────────────────────────────
hideCaption();
const rs = await at('find', 9, 'rs');
await moveTo(rs.x + rs.w / 2, rs.y + rs.h / 2, 900);
await click();
await sleep(200);
await moveTo(560, rs.y - 52, 500);
await caption([key('F2'), text('Rename Symbol')], { x: rs.x + rs.w, y: rs.y + rs.h / 2 });
await sleep(800);
await v.press('F2');
await waitFor(() => visible('.rename-box'), 4000);
await sleep(400);
await type('products', 110);
await sleep(350);
hideCaption();
await v.press('Enter');
await sleep(250);
await moveTo(860, 300, 700);
await caption([text('Renamed everywhere rs was used')], await at('lineEnd', 9));
await sleep(2200);

// ── 5. Any theme ───────────────────────────────────────────────────────────────
hideCaption();
await moveTo(930, 640, 600);
for (const [theme, label] of [
    ['Default Light Modern', 'Light Modern'],
    ['Monokai', 'Monokai'],
    ['Catppuccin Latte', 'Catppuccin Latte'],
    ['Catppuccin Mocha', 'Catppuccin Mocha'],
]) {
    crossfade(380);
    setTheme(theme);
    await sleep(500);
    await caption([text('Looks right in any theme'), { sub: label }], await at('lineEnd', 16));
    await sleep(1100);
}
// The last theme gets the same time as the others before the end card.
log({ type: 'end' });

await v.stopScreencast();
await sleep(300);
setTheme('Default Dark Modern');
fs.writeFileSync(`${S}/rec/cast.json`, JSON.stringify({ t0, frames, timeline }, null, 1));
console.log('frames', frames.length, 'events', timeline.length, 'seconds', ((Date.now() - t0) / 1000).toFixed(1));
process.exit(0);
