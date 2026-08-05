import * as assert from 'assert';
import {
    applyKeywordCase,
    applyIndentAfter,
    applyIndentForLine,
    formatSingleAspBlock,
    type AspFormatterSettings,
} from '../../formatter/aspFormatter';

const DEFAULT_SETTINGS: AspFormatterSettings = {
    keywordCase: 'PascalCase',
    useTabs: false,
    indentSize: 2,
    aspTagsOnSameLine: false,
    htmlIndentMode: 'flat',
};

const leadingSpaces = (line: string): number => (line.match(/^\s*/)?.[0].length ?? 0);

// F1 — keyword casing / operator spacing must never touch a trailing comment.
describe('applyKeywordCase — trailing comments', () => {
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
describe('applyKeywordCase — numeric / date literals', () => {
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
describe('applyKeywordCase — REM comments', () => {
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

describe('applyIndentAfter — REM comments do not trigger indent', () => {
    it('does not indent after a REM comment containing If ... Then', () => {
        assert.strictEqual(applyIndentAfter('REM if x then do something', 0, []), 0);
    });

    it('still indents after a real If ... Then block opener', () => {
        assert.strictEqual(applyIndentAfter('If x Then', 0, []), 1);
    });
});

// A colon joins statements, so a one-line `For … : Next` opens AND
// closes and must not leave the following line indented one level too deep.
describe('applyIndentForLine — colon-joined statements', () => {
    it('nets to zero for `For i = 1 To 3 : Next`', () => {
        assert.strictEqual(applyIndentForLine('For i = 1 To 3 : Next', 0, []).endLevel, 0);
    });

    it('still opens (+1) for a lone `For i = 1 To 3`', () => {
        assert.strictEqual(applyIndentForLine('For i = 1 To 3', 0, []).endLevel, 1);
    });

    it('keeps a single-line If with a colon body flat', () => {
        assert.strictEqual(applyIndentForLine('If x Then a = 1 : b = 2', 0, []).endLevel, 0);
    });

    it('balances `Do : Loop` on one line', () => {
        assert.strictEqual(applyIndentForLine('Do : Loop', 0, []).endLevel, 0);
    });

    it('ignores a colon inside a string literal', () => {
        // `x = "a : b"` is a single assignment, not two statements.
        assert.strictEqual(applyIndentForLine('x = "a : b"', 0, []).endLevel, 0);
    });
});

describe('formatSingleAspBlock — no over-indent after colon-joined loop', () => {
    it('aligns the line after `For i = 1 To 3 : Next` with the loop, not deeper', () => {
        const block = '<%\nFor i = 1 To 3 : Next\nResponse.Write "done"\n%>';
        const out   = formatSingleAspBlock(block, DEFAULT_SETTINGS).formatted;
        const lines = out.split('\n');
        const forLine  = lines.find(l => /\bNext\b/.test(l))!;
        const doneLine = lines.find(l => l.includes('Response.Write "done"'))!;
        assert.strictEqual(
            leadingSpaces(doneLine), leadingSpaces(forLine),
            `"done" must align with the For line; got ${JSON.stringify(out)}`,
        );
    });
});
