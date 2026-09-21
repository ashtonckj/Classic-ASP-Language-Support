import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { VBSCRIPT_KEYWORDS_SET } from '../../constants/aspKeywords';

// The name lists in the grammar — the intrinsic objects and their members,
// VBScript's functions and constants, the COM members — are generated from
// src/constants by scripts/sync-grammar-keywords.js as part of `npm run
// compile`, so they cannot drift and there is nothing here to test.
//
// The KEYWORD rules are the half that is still written by hand, because
// keyword.control / storage.type / storage.modifier split the keywords three
// ways that VBSCRIPT_KEYWORDS has no notion of, and the grammar spells them
// `End\s+If` where the constant is `'End If'`. These tests are what stands in
// for a generator there.

const GRAMMAR_PATH = path.join(__dirname, '..', '..', '..', 'syntaxes', 'asp.tmLanguage.json');
const grammar = JSON.parse(fs.readFileSync(GRAMMAR_PATH, 'utf8'));

interface Rule { name?: string; match?: string; comment?: string }

// Only the rules that carry a pattern — `keywords` also holds an `include`, and
// ByRef/ByVal live in their own entry so the parameter list of a declaration can
// reach the same list.
const keywordRules: Array<Rule & { match: string }> = [
    ...grammar.repository.keywords.patterns,
    ...grammar.repository['parameter-modifiers'].patterns,
].filter((rule: Rule) => typeof rule.match === 'string');

/** Every rule in the grammar that has a `match`, wherever it sits. */
function allRules(): Array<{ name: string; match: string }> {
    const found: Array<{ name: string; match: string }> = [];
    (function walk(node: unknown): void {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node && typeof node === 'object') {
            const rule = node as Rule;
            if (typeof rule.match === 'string') {
                found.push({ name: rule.name ?? '(unnamed)', match: rule.match });
            }
            Object.values(node as Record<string, unknown>).forEach(walk);
        }
    })(grammar);
    return found;
}

/** The bare words of an alternation like `(?i)\b(If|Then|End\s+If)\b`. */
function wordsOf(match: string): string[] {
    const alternation = /\(([^()]*)\)/.exec(match.replace('(?i)', ''));
    if (!alternation) { return []; }
    return alternation[1]
        .split('|')
        .flatMap(alternative => alternative.split('\\s+'))
        .map(word => word.trim())
        .filter(word => word.length > 0);
}

describe('Grammar keyword rules — every word is a VBScript keyword', () => {

    // `Return` and `Continue` sat in keyword.control for a long time. VBScript
    // dropped GoSub...Return and never had Continue, so both painted an
    // ordinary identifier as part of the language — the same defect as the COM
    // members that had found their way into the VBScript function list.
    for (const [index, rule] of keywordRules.entries()) {
        it(`${rule.name} (rule ${index}) lists nothing VBScript does not have`, () => {
            const unknown = wordsOf(rule.match)
                .filter(word => !VBSCRIPT_KEYWORDS_SET.has(word.toLowerCase()));
            assert.deepStrictEqual(
                unknown, [],
                `not VBScript keywords: ${unknown.join(', ')}`,
            );
        });
    }

    it('has no rule for Return or Continue', () => {
        const everyKeywordWord = keywordRules
            .flatMap(rule => wordsOf(rule.match ?? ''))
            .map(word => word.toLowerCase());
        for (const absent of ['return', 'continue']) {
            assert.ok(
                !everyKeywordWord.includes(absent),
                `${absent} is not a VBScript keyword`,
            );
        }
    });

    it('colours the keywords that had no rule at all', () => {
        // ReDim Preserve arr(10), Erase arr, Sub Foo(ByRef x), and Me inside a
        // Class all coloured as ordinary identifiers.
        const everyKeywordWord = keywordRules
            .flatMap(rule => wordsOf(rule.match ?? ''))
            .map(word => word.toLowerCase());
        for (const word of ['preserve', 'erase', 'byref', 'byval', 'me', 'stop']) {
            assert.ok(everyKeywordWord.includes(word), `${word} has no rule`);
        }
    });
});

describe('Grammar rules — the patterns are well formed', () => {

    it('compiles every match as a regular expression', () => {
        for (const { name, match } of allRules()) {
            assert.doesNotThrow(
                () => new RegExp(match.replace('(?i)', '')),
                `${name} does not compile: ${match}`,
            );
        }
    });

    // A backslash has to be escaped in JSON, and `"\b"` is not `\b` — it is the
    // JSON escape for a BACKSPACE, so the rule silently becomes an unanchored
    // match on a control character nobody types. It reads correctly in the file
    // and is invisible once parsed, which is exactly why it is worth a test.
    it('contains no control character left by a single-escaped \\b or \\t', () => {
        for (const { name, match } of allRules()) {
            const control = [...match].find(ch => ch.charCodeAt(0) < 0x20);
            assert.strictEqual(
                control, undefined,
                `${name} has a control character (U+${control?.charCodeAt(0).toString(16)}) — `
                + 'a backslash in a JSON string needs doubling',
            );
        }
    });

    it('anchors every bare-word alternation', () => {
        // Without \b, a rule listing `Me` also matches inside Member and Home.
        for (const { name, match } of allRules()) {
            if (!/^\(\?i\)\\b\([\w|]+\)/.test(match)) { continue; }
            assert.ok(
                match.includes('\\b('),
                `${name} starts an alternation without a word boundary`,
            );
        }
    });
});
