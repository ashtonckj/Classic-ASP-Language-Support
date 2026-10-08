import * as assert from 'assert';
import { ASP_MEMBER_DOCS, VBSCRIPT_FUNCTIONS, VBSCRIPT_KEYWORDS } from '../../constants/aspKeywords';
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

    it('the formatter knows every function the list does, and nothing else as one', () => {
        assert.deepStrictEqual(Object.values(VBSCRIPT_FUNCTIONS_MAP).sort(), [...functionNames].sort());
        assert.ok(!('cvar' in VBSCRIPT_FUNCTIONS_MAP), 'CVar is VBA, not VBScript: cscript says Type mismatch');
    });

    it('every member of the ASP objects is cased after a dot', () => {
        for (const { label } of Object.values(ASP_MEMBER_DOCS)) {
            const member = label.slice(label.indexOf('.') + 1);
            assert.strictEqual(MEMBER_CASING_MAP[member.toLowerCase()], member, label);
        }
    });

    it('a function is cased only by the function rule, never as a keyword', () => {
        // Every function may also be a variable's name (cscript compiles `Dim day`),
        // so none may sit in a table that cases the word wherever it appears.
        for (const word of [...KEYWORDS_SORTED, ...Object.keys(PROPER_CASING_MAP)]) {
            assert.ok(!functionByLower.has(word), `${word} is a function`);
        }
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
