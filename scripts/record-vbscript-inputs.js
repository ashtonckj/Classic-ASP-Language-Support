/**
 * record-vbscript-inputs.js
 *
 * A mocha --require hook that saves every page the unit tests hand to the
 * VBScript features, so compare-vbscript-parser.js can run the new parser
 * over the same awkward inputs the tests were written for.
 *
 *   npx mocha --require scripts/record-vbscript-inputs.js
 *
 * Writes out/vbscript-corpus.json when mocha exits. Needs a compiled out/.
 */

const fs = require('fs');
const path = require('path');

require('../out/test/unit/_mochaSetup.js');

const seen = new Set();

function textOf(arg) {
    if (typeof arg === 'string') { return arg; }
    if (arg && typeof arg.getText === 'function') { return arg.getText(); }
    return null;
}

function wrap(modulePath, names) {
    const mod = require(modulePath);
    for (const name of names) {
        const original = mod[name];
        if (typeof original !== 'function') { continue; }
        mod[name] = function (...args) {
            const text = textOf(args[0]);
            if (text !== null) { seen.add(text); }
            return original.apply(this, args);
        };
    }
}

wrap('../out/utils/symbolParser.js', ['extractSymbols']);
wrap('../out/providers/aspStructureDiagnosticsProvider.js', ['scanAspStructure', 'scanMissingSet', 'findMissingSet', 'getMatchedBlockPairs']);
wrap('../out/providers/aspRenameProvider.js', ['findSymbolLocations']);

process.on('exit', () => {
    const out = path.join(__dirname, '..', 'out', 'vbscript-corpus.json');
    fs.writeFileSync(out, JSON.stringify([...seen], null, 0));
    console.log(`recorded ${seen.size} distinct inputs to ${path.relative(process.cwd(), out)}`);
});
