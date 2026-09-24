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

    it('spaces \\ (integer divide) and ^ (power)', () => {
        assert.strictEqual(applyKeywordCase('x = 10\\3', 'PascalCase'), 'x = 10 \\ 3');
        assert.strictEqual(applyKeywordCase('y = 2^8', 'PascalCase'), 'y = 2 ^ 8');
    });

    it('does not space a trailing & Long-type suffix (100&)', () => {
        assert.strictEqual(applyKeywordCase('z = 100&', 'PascalCase'), 'z = 100&');
    });

    // `1.5E - 3` leaves `1.5E`, which is not a number, so the page stopped compiling.
    it('keeps the sign of an exponent inside the number', () => {
        assert.strictEqual(applyKeywordCase('x = 1.5E-3', 'PascalCase'), 'x = 1.5E-3');
        assert.strictEqual(applyKeywordCase('x = 2e+10 * .5E-2', 'PascalCase'), 'x = 2e+10 * .5E-2');
    });

    it('still spaces a minus after an identifier that merely ends in E', () => {
        assert.strictEqual(applyKeywordCase('x = rate1E-3', 'PascalCase'), 'x = rate1E - 3');
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

// A <%@ ... %> processing directive is only recognised by IIS in that exact
// one-line form. Splitting it — or letting keyword casing / operator spacing
// rewrite it — compiles the page as ordinary VBScript and breaks it.
describe('formatSingleAspBlock — <%@ %> processing directive', () => {
    it('keeps the directive on one line with the @ glued to the <%', () => {
        const out = formatSingleAspBlock('<%@ Language="VBScript" %>', DEFAULT_SETTINGS).formatted;
        assert.strictEqual(out, '<%@ Language="VBScript" %>');
    });

    it('preserves the directive verbatim, without operator spacing', () => {
        const out = formatSingleAspBlock('<%@ Language="VBScript" CodePage=65001 %>', DEFAULT_SETTINGS).formatted;
        assert.strictEqual(out, '<%@ Language="VBScript" CodePage=65001 %>');
    });

    it('normalises spacing around the delimiters only', () => {
        const out = formatSingleAspBlock('<%@Language="VBScript"%>', DEFAULT_SETTINGS).formatted;
        assert.strictEqual(out, '<%@ Language="VBScript" %>');
    });

    it('collapses a directive that was split over several lines back onto one', () => {
        const out = formatSingleAspBlock('<%@\n  Language="VBScript"\n%>', DEFAULT_SETTINGS).formatted;
        assert.strictEqual(out, '<%@ Language="VBScript" %>');
    });

    it('does not case directive text even when keywordCase is UPPERCASE', () => {
        const out = formatSingleAspBlock(
            '<%@ Language="VBScript" %>',
            { ...DEFAULT_SETTINGS, keywordCase: 'UPPERCASE' },
        ).formatted;
        assert.strictEqual(out, '<%@ Language="VBScript" %>');
    });

    it('still splits an ordinary single-line block onto its own line', () => {
        const out = formatSingleAspBlock('<% Option Explicit %>', DEFAULT_SETTINGS).formatted;
        assert.strictEqual(out, '<%\nOption Explicit\n%>');
    });
});

// The single-line block path built its indent from level 0 regardless of
// htmlIndentMode, while the multi-line path starts from the HTML depth in
// 'continuation' mode. So a one-line block came out at column 0 and then moved
// once the first format had turned it into a multi-line one — which is why that
// mode needed two passes to settle.
describe('formatSingleAspBlock — one-line and multi-line agree on the base indent', () => {

    const flat: AspFormatterSettings = {
        keywordCase: 'PascalCase', indentSize: 4, useTabs: false,
        aspTagsOnSameLine: false, htmlIndentMode: 'flat',
    };
    const continuation: AspFormatterSettings = { ...flat, htmlIndentMode: 'continuation' };

    // 'flat' puts the delimiters at column 0, so the VBScript inside has to
    // carry the HTML depth itself. 'continuation' puts them at the HTML indent,
    // which already supplies it. These two assertions are also what pins the
    // two values the right way round.
    it('carries the HTML depth inside the block in flat mode', () => {
        const out = formatSingleAspBlock('<% x = 1 %>', flat, '        ', 0);
        assert.strictEqual(out.formatted, '<%\n        x = 1\n%>');
    });

    it('leaves the depth to the surrounding indent in continuation mode', () => {
        const out = formatSingleAspBlock('<% x = 1 %>', continuation, '        ', 0);
        assert.strictEqual(out.formatted, '<%\nx = 1\n%>');
    });

    it('indents a one-line block the same as the multi-line form of it', () => {
        for (const settings of [flat, continuation]) {
            const single = formatSingleAspBlock('<% x = 1 %>',   settings, '    ', 0);
            const multi  = formatSingleAspBlock('<%\nx = 1\n%>', settings, '    ', 0);
            assert.strictEqual(single.formatted, multi.formatted, settings.htmlIndentMode);
        }
    });

    // An empty block has no content line to write. Emitting one anyway left <%
    // and %> separated by a line of nothing but indentation.
    it('writes no content line for an empty block', () => {
        for (const settings of [flat, continuation]) {
            assert.strictEqual(formatSingleAspBlock('<% %>',  settings, '    ', 0).formatted, '<%\n%>');
            assert.strictEqual(formatSingleAspBlock('<%  %>', settings, '    ', 0).formatted, '<%\n%>');
        }
    });
});

// A line that both finishes a `_` continuation and closes the block was read by
// the `%>` branch as a fresh statement, so it landed at the statement indent —
// column 0 — and only reached its alignment column on a SECOND format, once
// `%>` had moved to a line of its own.
describe('formatMultiLineAspBlock — a continuation that also closes the block', () => {

    const settings: AspFormatterSettings = {
        keywordCase: 'PascalCase', indentSize: 2, useTabs: false,
        aspTagsOnSameLine: false, htmlIndentMode: 'continuation',
    };

    it('aligns under the string when the first line has one', () => {
        const out = formatSingleAspBlock('<% s = "a" & _\n     "b" %>', settings, '', 0);
        assert.strictEqual(out.formatted, '<%\ns = "a" & _\n    "b"\n%>');
    });

    it('indents one level in when there is no string to align to', () => {
        const out = formatSingleAspBlock('<% Call Foo(1, _\n   2) %>', settings, '', 0);
        assert.strictEqual(out.formatted, '<%\nCall Foo(1, _\n  2)\n%>');
    });

    it('gives the same result whether or not %> shares the line', () => {
        // The two spellings are the same code, so they must format alike —
        // which is also what makes the whole file settle in one pass.
        const sharesLine = formatSingleAspBlock('<% s = "a" & _\n     "b" %>',     settings, '', 0);
        const ownLine    = formatSingleAspBlock('<%\ns = "a" & _\n     "b"\n%>',   settings, '', 0);
        assert.strictEqual(sharesLine.formatted, ownLine.formatted);
    });

    it('does not read the continued half as a statement of its own', () => {
        // `b Then` is half of `If a And b Then`. Running it through the
        // statement indenter moved the level as well as the column.
        const out = formatSingleAspBlock('<% If a And _\n   b Then %>', settings, '', 0);
        assert.strictEqual(out.formatted, '<%\nIf a And _\n  b Then\n%>');
    });

    it('keeps a multi-part SQL concatenation aligned', () => {
        const out = formatSingleAspBlock(
            '<% sql = "SELECT a" & _\n  " FROM t" & _\n  " WHERE x=1" %>', settings, '', 0);
        assert.strictEqual(
            out.formatted,
            '<%\nsql = "SELECT a" & _\n      " FROM t" & _\n      " WHERE x=1"\n%>',
        );
    });
});

// The casing tables mixed two different things: words that belong to VBScript,
// and names that belong to an object. Casing the second kind wherever it
// appeared meant the formatter quietly renamed people's variables — `Dim
// connectionString` came back as `Dim ConnectionString`, `For Each item` as
// `For Each Item`. VBScript is case-insensitive so nothing broke, but rewriting
// a name the author chose is not the formatter's business.
describe('applyKeywordCase — member names are only cased after a dot', () => {

    it('leaves a variable that happens to share a member name alone', () => {
        for (const [source, expected] of [
            ['Dim connectionString',       'Dim connectionString'],
            ['Dim recordset',              'Dim recordset'],
            ['Dim form, count, key',       'Dim form, count, key'],
            ['Dim writeLine, readAll',     'Dim writeLine, readAll'],
            ['For Each item In itemList',  'For Each item In itemList'],
        ]) {
            assert.strictEqual(applyKeywordCase(source, 'PascalCase'), expected);
        }
    });

    it('still cases a member reached through a dot', () => {
        for (const [source, expected] of [
            ['rs.movenext',                'rs.MoveNext'],
            ['conn.connectionstring = x',  'conn.ConnectionString = x'],
            ['Response.write "hi"',        'Response.Write "hi"'],
            ['fso.getfile(p)',             'fso.GetFile(p)'],
            ['Request.querystring("id")',  'Request.QueryString("id")'],
            ['d.removeall',                'd.RemoveAll'],
        ]) {
            assert.strictEqual(applyKeywordCase(source, 'PascalCase'), expected);
        }
    });

    it('cases a member reached through a leading dot inside With', () => {
        assert.strictEqual(
            applyKeywordCase('With rs : .movefirst : End With', 'PascalCase'),
            'With rs : .MoveFirst : End With',
        );
    });

    it('still cases the words that really are VBScript', () => {
        for (const [source, expected] of [
            ['dim x',                'Dim x'],
            ['if a then',            'If a Then'],
            ['for each k in d',      'For Each k In d'],
            ['redim preserve b(2)',  'ReDim Preserve b(2)'],
            ['elseif y then',        'ElseIf y Then'],
        ]) {
            assert.strictEqual(applyKeywordCase(source, 'PascalCase'), expected);
        }
    });

    // Title-casing each word gives `Goto`; the keyword has an internal capital.
    it('spells GoTo the way VBScript does', () => {
        assert.strictEqual(applyKeywordCase('on error goto 0', 'PascalCase'), 'On Error GoTo 0');
        assert.strictEqual(applyKeywordCase('On Error GoTo 0', 'PascalCase'), 'On Error GoTo 0');
        assert.strictEqual(applyKeywordCase('on  error  goto  0', 'PascalCase'), 'On Error GoTo 0');
    });

    // These are VB6/VBA file I/O. VBScript has none of them, so a variable named
    // `input` or `binary` was being cased for no reason at all.
    it('does not case words VBScript does not have', () => {
        for (const source of [
            'Dim input, output, append',
            'Dim binary, random',
            'Dim put, as, like',
        ]) {
            assert.strictEqual(applyKeywordCase(source, 'PascalCase'), source);
        }
    });
});
