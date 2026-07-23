import * as assert from 'assert';
import { applyKeywordCase, applyIndentAfter } from '../../formatter/aspFormatter';

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

// F5 — legacy REM comments must be treated as comments, not code.
describe('applyKeywordCase — REM comments (F5)', () => {
    it('does not keyword-case a full-line REM comment', () => {
        const out = applyKeywordCase('REM loop until the next item', 'PascalCase');
        assert.strictEqual(out, 'REM loop until the next item');
    });

    it('does not case a REM comment after a colon separator', () => {
        const out = applyKeywordCase('x=1 : REM end if here', 'PascalCase');
        assert.ok(out.includes('REM end if here'), `REM text preserved; got ${JSON.stringify(out)}`);
    });

    it('does not treat a "rem"-prefixed identifier as a comment', () => {
        const out = applyKeywordCase('remainder = 5', 'PascalCase');
        assert.ok(out.includes('remainder'), `identifier preserved; got ${JSON.stringify(out)}`);
    });
});

describe('applyIndentAfter — REM comments do not trigger indent (F5)', () => {
    it('does not indent after a REM comment containing If ... Then', () => {
        assert.strictEqual(applyIndentAfter('REM if x then do something', 0, []), 0);
    });

    it('still indents after a real If ... Then block opener', () => {
        assert.strictEqual(applyIndentAfter('If x Then', 0, []), 1);
    });
});
