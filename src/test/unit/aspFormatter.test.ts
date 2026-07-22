import * as assert from 'assert';
import { applyKeywordCase } from '../../formatter/aspFormatter';

// F1 — keyword casing / operator spacing must never touch a trailing comment.
describe('applyKeywordCase — trailing comments (F1)', () => {
    it('does not keyword-case a trailing comment', () => {
        const out = applyKeywordCase("x = 1 ' loop through next items", 'PascalCase');
        assert.ok(
            out.includes("' loop through next items"),
            `comment must be preserved verbatim; got ${JSON.stringify(out)}`,
        );
    });

    it('does not operator-space a URL inside a comment', () => {
        const out = applyKeywordCase("x = 1 ' see http://example.com/a", 'PascalCase');
        assert.ok(
            out.includes('http://example.com/a'),
            `URL must be preserved; got ${JSON.stringify(out)}`,
        );
    });

    it('still formats the code that precedes the comment', () => {
        const out = applyKeywordCase("dim x ' a note", 'PascalCase');
        assert.ok(/\bDim x\b/.test(out), `code should be cased; got ${JSON.stringify(out)}`);
        assert.ok(out.includes("' a note"), 'comment preserved');
    });

    it('treats an apostrophe inside a string as data, not a comment', () => {
        const out = applyKeywordCase('msg = "it\'s here"', 'PascalCase');
        assert.ok(out.includes('"it\'s here"'), `string preserved; got ${JSON.stringify(out)}`);
    });
});