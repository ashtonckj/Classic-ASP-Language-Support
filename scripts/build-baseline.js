/**
 * build-baseline.js
 *
 * Compiles an older commit into .baseline/, so compare-vbscript-parser.js can
 * run the code the parser replaced without that code staying in the extension.
 *
 *   node scripts/build-baseline.js [git ref, default main]
 *   node scripts/compare-vbscript-parser.js --baseline
 *
 * .baseline/ sits inside the repo so the compiler finds node_modules by
 * walking up, and it is ignored by git and by the VSIX.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const ref = process.argv[2] ?? 'main';
const dir = path.join(root, '.baseline');

const commit = cp.execFileSync('git', ['rev-parse', '--short', ref], { cwd: root, encoding: 'utf8' }).trim();

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);

const archive = cp.execFileSync('git', ['archive', '--format=tar', ref], { cwd: root, maxBuffer: 1 << 30 });
cp.execFileSync('tar', ['-x', '-C', dir, '--exclude=node_modules'], { input: archive });

if (fs.existsSync(path.join(dir, 'scripts/generate-dom-types.js'))) {
    cp.execFileSync(process.execPath, ['scripts/generate-dom-types.js'], { cwd: dir, stdio: 'ignore' });
}
cp.execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', '.'], { cwd: dir, stdio: 'inherit' });

fs.writeFileSync(path.join(dir, 'REF'), `${ref} ${commit}\n`);
console.log(`built ${ref} (${commit}) into .baseline/`);
