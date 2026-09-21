#!/usr/bin/env node
/**
 * sync-grammar-keywords.js
 *
 * Rewrites the name lists inside syntaxes/asp.tmLanguage.json from the
 * constants in src/constants/, so the grammar and the language data cannot say
 * different things about what Classic ASP contains.
 *
 * They had drifted in both directions, and neither direction was visible:
 *
 *   • The grammar knew Eval, GetRef, GetLocale, SetLocale, Escape, Unescape and
 *     the ScriptEngine functions; VBSCRIPT_FUNCTIONS did not. Those coloured as
 *     built-ins but had no completion and no hover.
 *   • The grammar's VBScript function list also held Add, Exists, Item, Items,
 *     Keys, Remove and RemoveAll — COM members, not global functions — plus
 *     Conversions, Derived, Math and Maths, which are not anything at all. A
 *     Sub named Add or a variable named Math coloured as part of the language.
 *   • MovePrev was in both, and is a member of nothing: ADO spells it
 *     MovePrevious.
 *
 * A generated list cannot drift, which is why this runs as part of
 * `npm run compile` rather than being something to remember.
 *
 * ── What is generated and what is not ───────────────────────────────────────
 * Generated: the flat lists of NAMES — the intrinsic objects and their members
 * split by kind, VBScript's global functions, VBScript's constants, and the COM
 * member names. Each is a set of words with one source of truth.
 *
 * Not generated: the keyword rules. `keyword.control` / `storage.type` /
 * `storage.modifier` divide the keywords into three groups that VBSCRIPT_KEYWORDS
 * has no notion of, and the grammar writes them as `End\s+If` where the constant
 * is `'End If'`. Those stay hand-written, and a unit test holds them to the
 * keyword set instead — which is what catches a `Return` or a `Continue` that
 * VBScript does not have.
 *
 * Usage:
 *   node scripts/sync-grammar-keywords.js           rewrite when out of date
 *   node scripts/sync-grammar-keywords.js --check   report drift, exit 1
 *
 * Reads the COMPILED constants from out/, so it runs after tsc in the compile
 * chain. That keeps one source of truth — the .ts files — rather than a second
 * parser that reads TypeScript with regexes.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const GRAMMAR     = path.join(ROOT, 'syntaxes', 'asp.tmLanguage.json');
const OUT_KEYWORDS = path.join(ROOT, 'out', 'constants', 'aspKeywords.js');
const OUT_COM      = path.join(ROOT, 'out', 'constants', 'comObjects.js');

const checkOnly = process.argv.includes('--check');

for (const file of [OUT_KEYWORDS, OUT_COM]) {
    if (!fs.existsSync(file)) {
        console.error(`[asp] ${path.relative(ROOT, file)} is missing — run \`npm run compile\` first.`);
        process.exit(1);
    }
}

const { ASP_OBJECTS, VBSCRIPT_FUNCTIONS, VBSCRIPT_CONSTANTS } = require(OUT_KEYWORDS);
const { COM_TYPE_MAP } = require(OUT_COM);

/** Unique, case-insensitively sorted, so the generated file is stable. */
function names(values) {
    const seen = new Map();
    for (const value of values) {
        if (!/^\w+$/.test(value)) {
            throw new Error(`"${value}" is not a bare word and cannot go in an alternation`);
        }
        const key = value.toLowerCase();
        if (!seen.has(key)) { seen.set(key, value); }
    }
    return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

const membersOfKind = kind =>
    names(ASP_OBJECTS.flatMap(o => o.members.filter(m => m.kind === kind).map(m => m.name)));

const OBJECT_NAMES = names(ASP_OBJECTS.map(o => o.name));

/**
 * The rules this script owns, as a path into the grammar plus the words it
 * should list.
 *
 * `dotted` marks a rule that may only match after a `.`. Without it the rule is
 * a plain `\b(...)\b` that fires on any word anywhere — which is how a variable
 * named `Status` or `Form`, or a Sub named `Clear`, ended up coloured as part
 * of the ASP object model. The object-access rule above them already colours
 * `Response.Buffer`; these exist for a member reached some other way, such as
 * `.Buffer` inside a `With Response` block, and that always has the dot.
 */
const RULES = [
    { repo: 'asp-objects', index: 0, words: OBJECT_NAMES,               dotted: false, suffix: '\\.(\\w+)' },
    { repo: 'asp-objects', index: 1, words: OBJECT_NAMES,               dotted: false },
    { repo: 'asp-objects', index: 2, words: membersOfKind('collection'), dotted: true },
    { repo: 'asp-objects', index: 3, words: membersOfKind('property'),   dotted: true },
    { repo: 'asp-objects', index: 4, words: membersOfKind('method'),     dotted: true },
    { repo: 'functions',   index: 0, words: names(VBSCRIPT_FUNCTIONS),   dotted: false },
    { repo: 'constants',   index: 1, words: names(VBSCRIPT_CONSTANTS.map(c => c.name)), dotted: false },
    {
        repo: 'com-members', index: 0, dotted: true,
        words: names(Object.values(COM_TYPE_MAP).flatMap(t => t.members.map(m => m.name))),
    },
];

function buildMatch(rule) {
    const lookbehind = rule.dotted ? '(?<=\\.)' : '';
    return `(?i)${lookbehind}\\b(${rule.words.join('|')})\\b${rule.suffix ?? ''}`;
}

// Edited as text rather than re-serialised. The file is CRLF with no trailing
// newline, so JSON.stringify would rewrite all 346 lines and bury a one-word
// change in a whole-file diff. Replacing just the `match` literal keeps the
// diff to the lines that actually changed.
let source      = fs.readFileSync(GRAMMAR, 'utf8');
const grammar   = JSON.parse(source);
const drift     = [];

for (const rule of RULES) {
    const pattern = grammar.repository[rule.repo]?.patterns?.[rule.index];
    if (!pattern) {
        console.error(`[asp] ${rule.repo}.patterns[${rule.index}] is gone — the grammar changed shape.`);
        process.exit(1);
    }

    const wanted = buildMatch(rule);
    if (pattern.match === wanted) { continue; }

    // The alternation is the LAST parenthesised group of bare words — anchor on
    // that rather than the first `(`, which is the `(?i)` flag, and after it the
    // `(?<=\.)` lookbehind.
    const before = new Set((/\(([\w|]+)\)/.exec(pattern.match)?.[1] ?? '').split('|'));
    const after  = new Set(rule.words);
    drift.push({
        rule:    `${pattern.name} (${rule.repo}.patterns[${rule.index}])`,
        added:   rule.words.filter(w => !before.has(w)),
        removed: [...before].filter(w => !after.has(w)),
    });

    const oldLiteral = JSON.stringify(pattern.match);
    const occurrences = source.split(oldLiteral).length - 1;
    if (occurrences !== 1) {
        console.error(
            `[asp] ${rule.repo}.patterns[${rule.index}]: its match appears ${occurrences} times `
            + 'in the file, so it cannot be replaced unambiguously.',
        );
        process.exit(1);
    }
    source = source.replace(oldLiteral, () => JSON.stringify(wanted));
}

if (drift.length === 0) {
    console.log('[asp] syntaxes/asp.tmLanguage.json already matches src/constants');
    process.exit(0);
}

for (const { rule, added, removed } of drift) {
    console.log(`[asp] ${rule}`);
    if (added.length)   { console.log(`        + ${added.join(' ')}`); }
    if (removed.length) { console.log(`        - ${removed.join(' ')}`); }
}

if (checkOnly) {
    console.error('[asp] the grammar is out of date — run `npm run sync-grammar`.');
    process.exit(1);
}

JSON.parse(source);   // a bad replacement must not reach disk
fs.writeFileSync(GRAMMAR, source, 'utf8');
console.log('[asp] rewrote syntaxes/asp.tmLanguage.json from src/constants');
