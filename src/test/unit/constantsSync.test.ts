import * as assert from 'assert';
import { VBSCRIPT_FUNCTIONS, VBSCRIPT_KEYWORDS } from '../../constants/aspKeywords';
import { KEYWORDS_SORTED, MEMBER_CASING_MAP, PROPER_CASING_MAP, VBSCRIPT_FUNCTIONS_MAP } from '../../formatter/aspFormatter';
import { KEYWORD_DOCS } from '../../asp/aspHoverProvider';
import { RESERVED } from '../../vbscript/parser';

// The name lists live in src/constants. The formatter's casing tables, the
// hover's keyword docs and the parser's reserved words are written out where
// they are used, so these tests keep them in step with the lists — a key
// spelled differently from its value is a word that is never cased.

const functionNames = VBSCRIPT_FUNCTIONS.map(name => String(name));
const functionByLower = new Map(functionNames.map(name => [name.toLowerCase(), name]));
const keywordWords = new Set(VBSCRIPT_KEYWORDS.flatMap(k => k.keyword.toLowerCase().split(/\s+/)));

describe('the name lists agree with src/constants', () => {
    it('every casing table is keyed by its own value, lower-cased', () => {
        for (const table of [PROPER_CASING_MAP, MEMBER_CASING_MAP, VBSCRIPT_FUNCTIONS_MAP]) {
            for (const [key, value] of Object.entries(table)) {
                assert.strictEqual(key, value.toLowerCase(), `${key} → ${value}`);
            }
        }
    });

    it('the formatter spells each function as the function list does', () => {
        for (const [lower, cased] of Object.entries(VBSCRIPT_FUNCTIONS_MAP)) {
            // CVar is VBA's, not VBScript's; whether the formatter should case it is open.
            if (lower === 'cvar') { continue; }
            assert.strictEqual(cased, functionByLower.get(lower), `${cased} is not in VBSCRIPT_FUNCTIONS as written`);
        }
    });

    it('lists the functions the formatter leaves as typed', () => {
        // Each is a real VBScript function the formatter has never cased. Pinned
        // here so a function added to the list is a decision, not an accident.
        const cased = new Set([
            ...Object.keys(VBSCRIPT_FUNCTIONS_MAP), ...Object.keys(PROPER_CASING_MAP), ...KEYWORDS_SORTED,
        ]);
        assert.deepStrictEqual(
            functionNames.filter(name => !cased.has(name.toLowerCase())),
            ['AscB', 'AscW', 'ChrB', 'ChrW', 'Execute', 'ExecuteGlobal', 'Hex', 'InStrB', 'LeftB', 'LenB', 'MidB', 'Oct', 'RightB'],
        );
    });

    it('every reserved word of the parser is a keyword word', () => {
        // `As` is reserved but starts no statement, so the keyword list has no entry for it.
        for (const word of RESERVED) {
            assert.ok(keywordWords.has(word) || word === 'as', `${word} is not in VBSCRIPT_KEYWORDS`);
        }
    });

    it('every word of a hover keyword doc is a keyword word', () => {
        for (const key of Object.keys(KEYWORD_DOCS)) {
            for (const word of key.split(/\s+/)) {
                assert.ok(keywordWords.has(word), `"${word}" of "${key}" is not in VBSCRIPT_KEYWORDS`);
            }
        }
    });
});
