// Drives an isolated VS Code window over the Chrome DevTools Protocol.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The demo-recording folder: rec/ (these scripts), demo/ (the page), vsc/ (the VS Code profile).
export const S = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/');
const CODE = 'C:/Users/stick/Desktop/classic-asp-language-support/.vscode-test/vscode-win32-x64-archive-1.139.1/Code.exe';
const PORT = 9333;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch(file, { width = 960, height = 800 } = {}) {
    const child = spawn(CODE, [
        `--user-data-dir=${S}/vsc/ud`, `--extensions-dir=${S}/vsc/ext`,
        `--remote-debugging-port=${PORT}`, '--disable-workspace-trust', '--skip-welcome',
        '--skip-release-notes', '--disable-telemetry', '--new-window', '--disable-gpu-sandbox',
        file,
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    let target;
    for (let i = 0; i < 120 && !target; i++) {
        await sleep(500);
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find(t => t.type === 'page' && /workbench/.test(t.url));
        } catch { /* not up yet */ }
    }
    if (!target) { throw new Error('VS Code did not open a debuggable window'); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.method && listeners.has(msg.method)) { listeners.get(msg.method)(msg.params); }
        if (msg.id && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
        const n = ++id;
        pending.set(n, { res, rej });
        ws.send(JSON.stringify({ id: n, method, params }));
    });

    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });

    const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

    const keyInfo = {
        Enter: [13, 'Enter'], Escape: [27, 'Escape'], End: [35, 'End'], Home: [36, 'Home'],
        F2: [113, 'F2'], F: [70, 'KeyF'], G: [71, 'KeyG'], Z: [90, 'KeyZ'], A: [65, 'KeyA'],
        '.': [190, 'Period'], Right: [39, 'ArrowRight'], Left: [37, 'ArrowLeft'], ' ': [32, 'Space'], Down: [40, 'ArrowDown'], Backspace: [8, 'Backspace'],
    };
    const MOD = { alt: 1, ctrl: 2, shift: 8 };

    async function press(combo) {
        const parts = combo.split('+');
        const k = parts.pop();
        const modifiers = parts.reduce((m, p) => m | MOD[p.toLowerCase()], 0);
        const [vk, code] = keyInfo[k];
        const key = { Down: 'ArrowDown', Right: 'ArrowRight', Left: 'ArrowLeft' }[k] ?? k;
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
        if (k === 'Enter' && modifiers === 0) {
            await send('Input.dispatchKeyEvent', { type: 'char', key, text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: vk });
        }
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    }

    async function typeChar(ch) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }

    async function click(x, y) {
        for (const type of ['mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        }
    }

    async function mouseMove(x, y) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    }

    /** Streams every frame VS Code paints to onFrame(pngBuffer, receivedAtMs). */
    async function startScreencast(onFrame) {
        listeners.set('Page.screencastFrame', p => {
            onFrame(Buffer.from(p.data, 'base64'), Date.now());
            void send('Page.screencastFrameAck', { sessionId: p.sessionId });
        });
        await send('Page.startScreencast', { format: 'png', maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    }
    const stopScreencast = () => send('Page.stopScreencast');

    async function shot(file) {
        const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
    }

    async function close() {
        try { await send('Browser.close'); } catch { /* the page target cannot close the browser */ }
        ws.close();
    }

    return { send, evaluate, press, typeChar, click, mouseMove, startScreencast, stopScreencast, shot, close };
}
