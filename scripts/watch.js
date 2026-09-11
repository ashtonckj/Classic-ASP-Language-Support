#!/usr/bin/env node
/**
 * watch.js
 *
 * The development watch: regenerates the baked DOM declarations whenever
 * src/utils/asp-dom.d.ts changes, and runs `tsc -watch` alongside it.
 *
 * Why a wrapper rather than two npm scripts joined by an operator: `&` and `&&`
 * behave differently across cmd.exe, PowerShell and sh, and `&&` would only run
 * the generator once — leaving an edit to the .d.ts silently doing nothing for
 * the rest of the session. Watching from inside this process keeps it portable
 * and keeps the two in step.
 *
 * tsc is spawned with stdio: 'inherit' so its output — including the
 * "Starting compilation in watch mode..." / "Found N errors. Watching for file
 * changes." lines — reaches the terminal untouched. VS Code's $tsc-watch problem
 * matcher keys off those exact lines to decide when the F5 build task is ready,
 * so nothing may filter or rewrite them.
 *
 * tsc is run as `node <path-to-tsc.js>` rather than through node_modules/.bin,
 * which avoids the .cmd shim and the shell entirely.
 */

const path = require('path');
const { spawn } = require('child_process');
const { watch } = require('./generate-dom-types');

const root = path.resolve(__dirname, '..');

// Keep the baked declarations in step with the .d.ts for the whole session.
watch();

const tsc = require.resolve('typescript/lib/tsc.js', { paths: [root] });
const child = spawn(process.execPath, [tsc, '-watch', '-p', '.'], {
    cwd: root,
    stdio: 'inherit',
});

child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
});
child.on('error', (err) => {
    console.error(`[asp] failed to start tsc: ${err.message}`);
    process.exit(1);
});

// Pass Ctrl+C through, so stopping the task stops tsc too.
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { child.kill(sig); });
}
