/**
 * compare-vbscript-parser.js
 *
 * Checks the VBScript parser (src/vbscript) and the features built on it, over
 * the test-files pages and, when present, the inputs recorded from the unit
 * tests (see record-vbscript-inputs.js).
 *
 *   node scripts/compare-vbscript-parser.js [--dir <folder>] [--baseline [<folder>]]
 *                                           [--cscript] [--mutants N] [--fuzz N] [--verbose]
 *
 *   --dir      reads every .asp and .inc under <folder> instead of test-files.
 *              Nothing is copied or sent anywhere; the report lands in out/.
 *   --baseline compares the symbols and the block warnings with an older
 *              build, .baseline/ unless a folder is given (make it with
 *              scripts/build-baseline.js). Every difference is either a new
 *              bug or an old one fixed, and each needs a decision.
 *   --cscript  asks Windows' own VBScript engine (cscript.exe) whether each
 *              page compiles, and compares that with the parser's errors.
 *              Nothing runs: the program starts with WScript.Quit.
 *   --fuzz N   cuts every test-files page N times at random places, the way a
 *              page looks mid-edit, and checks the parser never throws.
 *   --mutants N  breaks each test-files page that compiles cleanly in N small
 *              random ways (a few characters or a line deleted, a stray block
 *              keyword added) and asks cscript and the parser about each one.
 *   timing     always shown for pages, and for the baseline too when given.
 *
 * Needs a compiled out/ (npm run compile). Writes out/vbscript-compare.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);

// The providers import vscode; the unit-test stub stands in for it.
require(path.join(root, 'out/test/unit/_mochaSetup.js'));
const current = {
    extractSymbols:   require(path.join(root, 'out/utils/symbolParser.js')).extractSymbols,
    scanAspStructure: require(path.join(root, 'out/providers/aspStructureDiagnosticsProvider.js')).scanAspStructure,
};
const { symbolsFromTree, parsePage, lineAt } = require(path.join(root, 'out/vbscript/symbols.js'));
const { pagePrograms } = require(path.join(root, 'out/vbscript/pageSegments.js'));

const baselineIndex = args.indexOf('--baseline');
const baselineDir = baselineIndex === -1 ? null
    : path.resolve(args[baselineIndex + 1] && !args[baselineIndex + 1].startsWith('--') ? args[baselineIndex + 1] : path.join(root, '.baseline'));
let baseline = null;
if (baselineDir) {
    const out = path.join(baselineDir, 'out');
    if (!fs.existsSync(out)) { throw new Error(`No compiled baseline in ${out}; run node scripts/build-baseline.js first.`); }
    require(path.join(out, 'test/unit/_mochaSetup.js'));
    baseline = {
        ref:              fs.existsSync(path.join(baselineDir, 'REF')) ? fs.readFileSync(path.join(baselineDir, 'REF'), 'utf8').trim() : baselineDir,
        extractSymbols:   require(path.join(out, 'utils/symbolParser.js')).extractSymbols,
        scanAspStructure: require(path.join(out, 'providers/aspStructureDiagnosticsProvider.js')).scanAspStructure,
    };
}

const useCscript = args.includes('--cscript');
const verbose = args.includes('--verbose');
const fuzzIndex = args.indexOf('--fuzz');
const fuzzCount = fuzzIndex === -1 ? 0 : Number(args[fuzzIndex + 1] ?? 200);
const mutantIndex = args.indexOf('--mutants');
const mutantCount = mutantIndex === -1 ? 0 : Number(args[mutantIndex + 1] ?? 50);

// ── Corpus ───────────────────────────────────────────────────────────────────

function listPages(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { found.push(...listPages(full)); }
        else if (/\.(asp|inc)$/i.test(entry.name)) { found.push(full); }
    }
    return found;
}

const dirIndex = args.indexOf('--dir');
const pageRoot = dirIndex === -1 ? path.join(root, 'test-files') : path.resolve(args[dirIndex + 1]);

const docs = listPages(pageRoot).map(file => ({
    name: path.relative(pageRoot, file).replace(/\\/g, '/'),
    text: fs.readFileSync(file, 'utf8'),
    isPage: true,
}));

const recorded = path.join(root, 'out/vbscript-corpus.json');
if (dirIndex === -1 && fs.existsSync(recorded)) {
    JSON.parse(fs.readFileSync(recorded, 'utf8')).forEach((text, i) => {
        docs.push({ name: `unit-test input #${i + 1}`, text, isPage: false });
    });
}

// ── Symbols ──────────────────────────────────────────────────────────────────

const FIELDS = {
    variables:    ['implicit'],
    constants:    ['value'],
    functions:    ['kind', 'params', 'paramNames', 'endLine'],
    comVariables: ['progId'],
    classes:      ['endLine'],
};

function norm(field, value) {
    if (field === 'implicit') { return !!value; }
    if (field === 'kind') { return String(value).toLowerCase(); }
    if (field === 'paramNames') { return JSON.stringify(value); }
    return value;
}

/** Each difference between the two symbol lists, as one line of text. */
function diffSymbols(oldS, newS) {
    const out = [];
    for (const [group, fields] of Object.entries(FIELDS)) {
        const key = s => `${s.name.toLowerCase()}@${s.line + 1}`;
        const newLeft = [...newS[group]];
        for (const o of oldS[group]) {
            const i = newLeft.findIndex(n => key(n) === key(o));
            if (i === -1) { out.push(`${group}: only old has ${o.name} (line ${o.line + 1})`); continue; }
            const n = newLeft.splice(i, 1)[0];
            for (const f of fields) {
                if (norm(f, o[f]) !== norm(f, n[f])) {
                    out.push(`${group}: ${o.name} (line ${o.line + 1}) ${f} old=${JSON.stringify(o[f])} new=${JSON.stringify(n[f])}`);
                }
            }
        }
        for (const n of newLeft) { out.push(`${group}: only new has ${n.name} (line ${n.line + 1})`); }
    }
    return out;
}

// ── Block warnings ───────────────────────────────────────────────────────────

let documentCount = 0;

/** Enough of a vscode.TextDocument for the structure scanners. */
function fakeDocument(text) {
    const lines = text.split('\n');
    const starts = [];
    let acc = 0;
    for (const l of lines) { starts.push(acc); acc += l.length + 1; }
    const uri = `compare:${++documentCount}`;
    return {
        uri:       { toString: () => uri, scheme: 'compare', fsPath: uri },
        getText:   () => text,
        lineCount: lines.length,
        lineAt:    i => ({ text: lines[i].replace(/\r$/, '') }),
        offsetAt:  p => starts[p.line] + p.character,
    };
}

/** Each block warning only one side gives, as one line of text. */
function diffDiagnostics(oldD, newD) {
    const key = d => `line ${d.range.start.line + 1}: ${d.message}`;
    const newLeft = newD.map(key);
    const out = [];
    for (const k of oldD.map(key)) {
        const i = newLeft.indexOf(k);
        if (i === -1) { out.push(`warning: only old has ${k}`); } else { newLeft.splice(i, 1); }
    }
    for (const k of newLeft) { out.push(`warning: only new has ${k}`); }
    return out;
}

// ── cscript ──────────────────────────────────────────────────────────────────

const cscriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbs-oracle-'));

/**
 * Builds one program as IIS would compile it: each code block as written,
 * `<%= e %>` as `Response.Write e`, and each HTML chunk as a WriteBlock call,
 * one per line. Returns the source and the page line of each of its lines.
 */
function oracleSource(page, segments) {
    const lines = [];
    const map = [];
    for (const seg of segments) {
        let piece = page.text.slice(seg.start, seg.end);
        if (seg.kind === 'output') { piece = 'Response.Write ' + piece; }
        if (seg.kind === 'html') { piece = 'Response.WriteBlock 0'; }
        const first = lineAt(page, seg.start);
        piece.split('\n').forEach((l, k) => { lines.push(l.replace(/\r$/, '')); map.push(first + k); });
    }

    // Stop before anything runs. Option Explicit must stay the first statement.
    const leadingOption = /^((\s|'.*)*)(option\s+explicit)/i;
    let body = lines.join('\r\n');
    if (leadingOption.test(body)) {
        body = body.replace(leadingOption, (m, pre, _s, opt) => `${pre}${opt} : WScript.Quit 0`);
    } else {
        body = 'WScript.Quit 0\r\n' + body;
        map.unshift(-1);
    }
    return { body, map };
}

function runCscript(body) {
    const file = path.join(cscriptDir, 'page.vbs');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
    const r = cp.spawnSync('cscript', ['//nologo', file], { encoding: 'latin1' });
    const m = /\((\d+), (\d+)\) Microsoft VBScript (compilation|runtime) error: (.*)/.exec(r.stderr || '');
    return m ? { line: Number(m[1]) - 1, message: m[4].trim() } : null;
}

// Errors that need the names in scope, which the parser leaves to later checks.
const SEMANTIC = /Name redefined/;

function oracleCompare(doc) {
    if (/<%@[^%]*language\s*=\s*"?(jscript|javascript)/i.test(doc.text)) { return null; }
    const page = parsePage(doc.text);
    const programs = pagePrograms(doc.text);
    let verdict = 'agree-clean';
    const notes = [];

    programs.forEach((segments, i) => {
        const { body, map } = oracleSource(page, segments);
        const cs = runCscript(body);
        // cscript reports a block left open on the last line of the source, which
        // is a WriteBlock when the page ends in HTML; the parser reports it at
        // the end of the page. Both mean the end of the program.
        const programEnd = lineAt(page, segments[segments.length - 1].end);
        const csLine = cs ? (cs.line < map.length - 1 ? map[cs.line] : programEnd) : null;
        const ours = page.programs[i].diagnostics.map(d => ({ line: lineAt(page, d.start), message: d.message }));

        let v;
        if (!cs && ours.length === 0) { v = 'agree-clean'; }
        else if (!cs) { v = 'parser-only'; notes.push(`parser: line ${ours[0].line + 1} ${ours[0].message}`); }
        else if (ours.length === 0) {
            v = SEMANTIC.test(cs.message) ? 'cscript-only-semantic' : 'cscript-only';
            notes.push(`cscript: line ${csLine + 1} ${cs.message}`);
        } else if (ours.some(d => d.line === csLine)) { v = 'agree-error'; }
        else {
            v = 'error-line-differs';
            notes.push(`cscript: line ${csLine + 1} ${cs.message}`, `parser: line ${ours[0].line + 1} ${ours[0].message}`);
        }
        const rank = ['agree-clean', 'agree-error', 'cscript-only-semantic', 'error-line-differs', 'cscript-only', 'parser-only'];
        if (rank.indexOf(v) > rank.indexOf(verdict)) { verdict = v; }
    });
    return { verdict, notes };
}

// ── Fuzzing ──────────────────────────────────────────────────────────────────

function prng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function fuzz(doc, count) {
    const rand = prng(doc.text.length);
    const failures = [];
    let worst = { ms: 0, how: '' };
    for (let i = 0; i < count; i++) {
        const at = Math.floor(rand() * doc.text.length);
        const cut = i % 2 === 0
            ? { how: `cut at ${at}`, text: doc.text.slice(0, at) }
            : { how: `delete ${at}+${1 + Math.floor(rand() * 200)}`, text: doc.text.slice(0, at) + doc.text.slice(at + 1 + Math.floor(rand() * 200)) };
        const t0 = process.hrtime.bigint();
        try { symbolsFromTree(cut.text, 'fuzz'); }
        catch (e) { failures.push(`${cut.how}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms > worst.ms) { worst = { ms, how: cut.how }; }
    }
    return { failures, worst };
}

const STRAY_LINES = ['If x Then', 'End If', 'Else', 'Next', 'Loop', 'Wend', 'End Sub', 'End Function',
    'Select Case x', 'Case 1', 'For i = 1 To 2', 'Do While x', 'Sub Extra()', 'End With', 'Dim', 'x = (1'];

/** One small random edit inside the page's VBScript, and what it was. */
function mutate(text, rand) {
    const code = pagePrograms(text).flat().filter(seg => seg.kind !== 'html' && seg.end > seg.start);
    const total = code.reduce((n, seg) => n + seg.end - seg.start, 0);
    let pick = Math.floor(rand() * total);
    const seg = code.find(c => (pick -= c.end - c.start) < 0) ?? code[0];
    if (!seg) { return null; }
    const at = seg.start + Math.floor(rand() * (seg.end - seg.start));
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    let lineEnd = text.indexOf('\n', at);
    if (lineEnd === -1) { lineEnd = text.length; }

    const r = rand();
    if (r < 0.5) {
        const len = 1 + Math.floor(rand() * 30);
        const end = Math.min(at + len, seg.end);
        return { text: text.slice(0, at) + text.slice(end), how: `deleted ${JSON.stringify(text.slice(at, end))}` };
    }
    if (r < 0.75 && lineStart >= seg.start && lineEnd <= seg.end) {
        return { text: text.slice(0, lineStart) + text.slice(lineEnd), how: `deleted line ${JSON.stringify(text.slice(lineStart, lineEnd).trim())}` };
    }
    const stray = STRAY_LINES[Math.floor(rand() * STRAY_LINES.length)];
    const insertAt = lineStart >= seg.start ? lineStart : seg.start;
    return { text: text.slice(0, insertAt) + stray + '\n' + text.slice(insertAt), how: `added line ${JSON.stringify(stray)}` };
}

/**
 * A lone CR is a line break to cscript but not to the line map, so a mutant
 * must not leave one behind (deleting the LF of a CRLF would).
 */
function withoutLoneCr(m) {
    return m && { ...m, text: m.text.replace(/\r(?!\n)/g, '') };
}

function mutants(doc, count) {
    const rand = prng(doc.text.length * 7 + 1);
    const tally = {};
    const disagreements = [];
    for (let i = 0; i < count; i++) {
        const m = withoutLoneCr(mutate(doc.text, rand));
        if (!m) { break; }
        const result = oracleCompare({ text: m.text });
        if (!result) { continue; }
        tally[result.verdict] = (tally[result.verdict] ?? 0) + 1;
        if (!result.verdict.startsWith('agree')) { disagreements.push(`${m.how}: ${result.notes.join(' / ')}`); }
    }
    return { tally, disagreements };
}

function timeIt(fn, runs) {
    const times = [];
    for (let i = 0; i < runs; i++) {
        const t0 = process.hrtime.bigint();
        fn();
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
}

// ── Run ──────────────────────────────────────────────────────────────────────

const report = { docs: [], totals: { docs: docs.length, identical: 0, differences: 0, oracle: {}, mutants: {} } };

for (const doc of docs) {
    const entry = { name: doc.name, lines: doc.text.split('\n').length };
    let newS;
    let newD;
    try {
        newS = current.extractSymbols(doc.text, 'page');
        newD = current.scanAspStructure(fakeDocument(doc.text));
    } catch (e) {
        entry.crash = String(e && e.stack || e);
        report.docs.push(entry);
        continue;
    }
    if (baseline) {
        entry.differences = [
            ...diffSymbols(baseline.extractSymbols(doc.text, 'page'), newS),
            ...diffDiagnostics(baseline.scanAspStructure(fakeDocument(doc.text)), newD),
        ];
        report.totals.differences += entry.differences.length;
        if (entry.differences.length === 0) { report.totals.identical++; }
    }

    if (doc.isPage) {
        const runs = entry.lines > 2000 ? 5 : 21;
        entry.ms = { new: timeIt(() => current.scanAspStructure(fakeDocument(doc.text)), runs) };
        if (baseline) { entry.ms.old = timeIt(() => baseline.scanAspStructure(fakeDocument(doc.text)), runs); }
    }
    if (useCscript) {
        entry.oracle = oracleCompare(doc);
        if (entry.oracle) { report.totals.oracle[entry.oracle.verdict] = (report.totals.oracle[entry.oracle.verdict] ?? 0) + 1; }
    }
    if (fuzzCount > 0 && doc.isPage) { entry.fuzz = fuzz(doc, fuzzCount); }
    if (mutantCount > 0 && doc.isPage && oracleCompare(doc)?.verdict === 'agree-clean') {
        entry.mutants = mutants(doc, mutantCount);
        for (const [k, v] of Object.entries(entry.mutants.tally)) { report.totals.mutants[k] = (report.totals.mutants[k] ?? 0) + v; }
    }
    report.docs.push(entry);
}

fs.rmSync(cscriptDir, { recursive: true, force: true });
fs.writeFileSync(path.join(root, 'out/vbscript-compare.json'), JSON.stringify(report, null, 2));

// ── Print ────────────────────────────────────────────────────────────────────

for (const d of report.docs) {
    const bits = [];
    if (d.crash) { bits.push('CRASH'); }
    if (d.differences) { bits.push(d.differences.length === 0 ? 'same as baseline' : `${d.differences.length} difference(s) from baseline`); }
    if (d.ms) { bits.push(`${d.ms.old === undefined ? '' : `old ${d.ms.old.toFixed(1)} ms, `}new ${d.ms.new.toFixed(1)} ms`); }
    if (d.oracle) { bits.push(`cscript: ${d.oracle.verdict}`); }
    if (d.fuzz) { bits.push(`fuzz: ${d.fuzz.failures.length} throw(s), slowest ${d.fuzz.worst.ms.toFixed(1)} ms`); }
    if (d.mutants) { bits.push('mutants: ' + Object.entries(d.mutants.tally).map(([k, v]) => `${k} ${v}`).join(', ')); }

    const interesting = d.crash || (d.differences && d.differences.length > 0)
        || (d.oracle && !d.oracle.verdict.startsWith('agree')) || (d.fuzz && d.fuzz.failures.length > 0);
    if (!interesting && !d.ms && !verbose) { continue; }

    console.log(`${d.name} (${d.lines} lines): ${bits.join('; ')}`);
    if (d.crash) { console.log('    ' + d.crash.split('\n').slice(0, 4).join('\n    ')); }
    for (const line of d.differences ?? []) { console.log('    ' + line); }
    for (const line of d.oracle?.notes ?? []) { console.log('    ' + line); }
    for (const line of (d.fuzz?.failures ?? []).slice(0, 5)) { console.log('    ' + line); }
    for (const line of d.mutants?.disagreements ?? []) { console.log('    mutant ' + line); }
}

const t = report.totals;
console.log('');
console.log(baseline
    ? `${t.docs} inputs against ${baseline.ref}: ${t.identical} the same, ${t.differences} difference(s) in total.`
    : `${t.docs} inputs checked.`);
if (useCscript) { console.log('cscript: ' + Object.entries(t.oracle).map(([k, v]) => `${k} ${v}`).join(', ')); }
if (mutantCount > 0) { console.log('mutants: ' + Object.entries(t.mutants).map(([k, v]) => `${k} ${v}`).join(', ')); }
