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

// F2 — hex/octal (&H/&O) and #date# literals must not be operator-spaced.
describe('applyKeywordCase — numeric / date literals (F2)', () => {
    it('does not break a &H hex literal', () => {
        const out = applyKeywordCase('x = &H1F', 'PascalCase');
        assert.ok(out.includes('&H1F'), `hex literal must stay intact; got ${JSON.stringify(out)}`);
        assert.ok(!/&\s+H1F/.test(out), `no space inserted after &; got ${JSON.stringify(out)}`);
    });

    it('does not break a &O octal literal', () => {
        const out = applyKeywordCase('x = &O17', 'PascalCase');
        assert.ok(out.includes('&O17'), `octal literal must stay intact; got ${JSON.stringify(out)}`);
    });

    it('does not break a #..# date literal', () => {
        const out = applyKeywordCase('d = #12/25/2024#', 'PascalCase');
        assert.ok(out.includes('#12/25/2024#'), `date literal must stay intact; got ${JSON.stringify(out)}`);
    });

    it('still spaces a genuine & concatenation operator', () => {
        const out = applyKeywordCase('a="x"&y', 'PascalCase');
        assert.ok(out.includes('"x" & y'), `concatenation & should be spaced; got ${JSON.stringify(out)}`);
    });
});
