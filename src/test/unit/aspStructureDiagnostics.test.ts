import * as assert from 'assert';
import * as vscode from 'vscode';
import { branchEvents, classifyLine, findMissingIncludes, findMissingSet, getMatchedBlockPairs, scanAspStructure } from '../../providers/aspStructureDiagnosticsProvider';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function kinds(actions: Array<{ type: string; kind: string }>): string[] {
    return actions.map(a => `${a.type}:${a.kind}`);
}

let pageCount = 0;

/** Enough of a document for the block scan, which reads only the text. */
function pageDoc(text: string): vscode.TextDocument {
    const uri = `file:///page-${++pageCount}.asp`;
    return { uri: { toString: () => uri }, getText: () => text } as unknown as vscode.TextDocument;
}

/** Each block warning as "line:column message". */
function warnings(text: string): string[] {
    return scanAspStructure(pageDoc(text)).map(d => `${d.range.start.line}:${d.range.start.character} ${d.message}`);
}

// Only the code INSIDE <% %> is VBScript; the HTML around an inline <%= %>
// must never count, or prose words like "with", "do", "class" fake a block
// opener and raise a false "Missing End …".
describe('scanAspStructure — HTML prose is not read as VBScript', () => {
    it('ignores HTML text around an inline <%= %> output expression', () => {
        assert.deepStrictEqual(warnings('<td>Total <%= x %> items with tax</td>'), []);
    });

    it('does not fake a Do / Class opener from prose next to <%= %>', () => {
        assert.deepStrictEqual(warnings('What to do <%= a %> now\nsee class notes <%= b %>'), []);
    });

    it('still reads a real inline <% %> statement block', () => {
        assert.deepStrictEqual(warnings('<% With obj %>'),
            ["0:3 Missing closing keyword — no 'End With' found for this 'With'"]);
    });

    it('pairs two <% %> blocks on one line', () => {
        assert.deepStrictEqual(warnings('<% If a Then %>x<% End If %>'), []);
        assert.strictEqual(getMatchedBlockPairs(pageDoc('<% If a Then %>x<% End If %>')).length, 1);
    });

    it('reads the lines of a multi-line block as code', () => {
        assert.deepStrictEqual(warnings('<%\nWith obj\n%>'),
            ["1:0 Missing closing keyword — no 'End With' found for this 'With'"]);
    });
});

describe('scanAspStructure — block warnings from the syntax tree', () => {
    it('puts the warning on the Sub of a Public Sub', () => {
        assert.deepStrictEqual(warnings('<%\n  Public Sub Save()\n%>'),
            ["1:9 Missing closing keyword — no 'End Sub' found for this 'Sub'"]);
    });

    it('names Do While, For Each and Select Case in full', () => {
        assert.deepStrictEqual(warnings('<%\nDo While x\n%>'), ["1:0 Missing closing keyword — no 'Loop' found for this 'Do While'"]);
        assert.deepStrictEqual(warnings('<%\nFor Each i In c\n%>'), ["1:0 Missing closing keyword — no 'Next' found for this 'For Each'"]);
        assert.deepStrictEqual(warnings('<%\nSelect Case x\n%>'), ["1:0 Missing closing keyword — no 'End Select' found for this 'Select Case'"]);
    });

    it('reports a closer with nothing to close', () => {
        assert.deepStrictEqual(warnings('<%\nWend\nend  if\n%>'), [
            "1:0 Unexpected closing keyword — no matching opener found for 'Wend'",
            "2:0 Unexpected closing keyword — no matching opener found for 'End If'",
        ]);
    });

    it('reports an End Function that ends a Sub as both a stray closer and a missing End Sub', () => {
        assert.deepStrictEqual(warnings('<%\nSub A\nEnd Function\n%>'), [
            "1:0 Missing closing keyword — no 'End Sub' found for this 'Sub'",
            "2:0 Unexpected closing keyword — no matching opener found for 'End Function'",
        ]);
    });

    it('closes blocks a one-line If holds, and needs no End If for the If itself', () => {
        assert.deepStrictEqual(warnings('<%\nIf x Then y = 1 Else z = 2\nIf a Then b = 1 : c = 2\n%>'), []);
    });

    it('does not count keywords in strings, comments or after a dot', () => {
        assert.deepStrictEqual(warnings('<%\nx = "If a Then" \' For i\nrs.Loop : obj.Next\n%>'), []);
    });

    it('reads an If whose condition runs over two lines', () => {
        assert.deepStrictEqual(warnings('<%\nIf a And _\n   b Then\n  x = 1\nEnd If\n%>'), []);
    });
});

// A REM comment (like a ' comment) must never be classified, or a
// commented-out opener such as `REM If x Then` fakes a "Missing End If".
describe('classifyLine — REM comments are not classified', () => {
    it('does not open an If for a REM-commented If', () => {
        assert.deepStrictEqual(classifyLine('REM If x Then'), []);
    });

    it('handles the inline <% REM If x Then %> form', () => {
        assert.deepStrictEqual(warnings('<% REM If x Then %>'), []);
    });

    it('ignores a REM after a colon separator', () => {
        assert.deepStrictEqual(classifyLine('x = 1 : REM For each row'), []);
    });

    it('still classifies a real If (guards against over-stripping)', () => {
        assert.deepStrictEqual(kinds(classifyLine('If x Then')), ['open:if']);
    });

    it('does not treat a "rem"-prefixed identifier as a comment', () => {
        assert.deepStrictEqual(classifyLine('remainder = 5'), []);
    });
});

// A `:`-joined one-liner must be seen as BOTH an opener and a closer, so it
// balances and no false "Missing …" diagnostic is raised.
describe('classifyLine — colon-joined statements', () => {
    it('sees opener AND closer in `For i = 1 To 10 : Next`', () => {
        assert.deepStrictEqual(kinds(classifyLine('For i = 1 To 10 : Next')), ['open:for', 'close:for']);
    });

    it('balances `Do : Loop` on one line', () => {
        assert.deepStrictEqual(kinds(classifyLine('Do : Loop')), ['open:do', 'close:do']);
    });
});

// Member access (obj.Do, rs.With) must not be read as a block keyword.
describe('classifyLine — member access is not a block keyword', () => {
    it('does not open a Do block for obj.Do', () => {
        assert.deepStrictEqual(classifyLine('obj.Do'), []);
    });

    it('does not open a With block for rs.With', () => {
        assert.deepStrictEqual(classifyLine('x = rs.With'), []);
    });

    it('does not treat Set x = obj.Do() as a block', () => {
        assert.deepStrictEqual(classifyLine('Set x = obj.Do()'), []);
    });
});

// getMatchedBlockPairs powers the matching-keyword highlight — it must find
// exactly the pairs scanAspStructure agrees are correctly closed, sharing the
// same scan so the two can never disagree.
describe('getMatchedBlockPairs', () => {
    function doc(text: string): vscode.TextDocument {
        const lines = text.split('\n');
        const lineOffsets: number[] = [];
        let acc = 0;
        for (const l of lines) { lineOffsets.push(acc); acc += l.length + 1; }
        return {
            getText:   () => text,
            lineCount: lines.length,
            lineAt:    (i: number) => ({ text: lines[i] }),
            offsetAt:  (pos: vscode.Position) => lineOffsets[pos.line] + pos.character,
        } as unknown as vscode.TextDocument;
    }

    it('matches a simple If ... End If', () => {
        const pairs = getMatchedBlockPairs(doc('<%\nIf x Then\n  y = 1\nEnd If\n%>'));
        assert.strictEqual(pairs.length, 1);
        assert.strictEqual(pairs[0].opener.text, 'If');
        assert.strictEqual(pairs[0].opener.range.start.line, 1);
        assert.strictEqual(pairs[0].closer.text, 'End If');
        assert.strictEqual(pairs[0].closer.range.start.line, 3);
    });

    it('matches nested blocks as two separate, correctly nested pairs', () => {
        const text = [
            '<%',              // 0
            'Sub Foo',         // 1
            '  If x Then',     // 2
            '    y = 1',       // 3
            '  End If',        // 4
            'End Sub',         // 5
            '%>',              // 6
        ].join('\n');
        const pairs = getMatchedBlockPairs(doc(text));
        assert.strictEqual(pairs.length, 2);

        const ifPair  = pairs.find(p => p.opener.text === 'If')!;
        const subPair = pairs.find(p => p.opener.text === 'Sub')!;
        assert.ok(ifPair && subPair, `expected both an If and a Sub pair; got ${JSON.stringify(pairs.map(p => p.opener.text))}`);
        assert.strictEqual(ifPair.opener.range.start.line, 2);
        assert.strictEqual(ifPair.closer.range.start.line, 4);
        assert.strictEqual(subPair.opener.range.start.line, 1);
        assert.strictEqual(subPair.closer.range.start.line, 5);
    });

    it('does not report a pair for an unclosed block', () => {
        const pairs = getMatchedBlockPairs(doc('<%\nIf x Then\n  y = 1\n%>'));
        assert.deepStrictEqual(pairs, []);
        // scanAspStructure must still flag it — the two must agree.
        assert.strictEqual(scanAspStructure(doc('<%\nIf x Then\n  y = 1\n%>')).length, 1);
    });

    it('does not report a pair for a stray closer with no opener', () => {
        const pairs = getMatchedBlockPairs(doc('<%\nEnd If\n%>'));
        assert.deepStrictEqual(pairs, []);
    });

    it('a one-liner opener+closer joined by a colon still matches', () => {
        const pairs = getMatchedBlockPairs(doc('<%\nFor i = 1 To 10 : Next\n%>'));
        assert.strictEqual(pairs.length, 1);
        assert.strictEqual(pairs[0].opener.text, 'For');
        assert.strictEqual(pairs[0].closer.text, 'Next');
    });
});

// Real keywords must still be classified (guard against over-correction).
describe('classifyLine — real keywords still classified', () => {
    it('opens Do While', () => {
        assert.deepStrictEqual(kinds(classifyLine('Do While x > 0')), ['open:do']);
    });

    it('opens a block If ... Then', () => {
        assert.deepStrictEqual(kinds(classifyLine('If x Then')), ['open:if']);
    });

    it('treats single-line If ... Then <stmt> as opening nothing', () => {
        assert.deepStrictEqual(classifyLine('If x Then y = 1'), []);
    });

    it('closes End If and Next', () => {
        assert.deepStrictEqual(kinds(classifyLine('End If')), ['close:if']);
        assert.deepStrictEqual(kinds(classifyLine('Next')), ['close:for']);
    });

    it('opens With / closes End With', () => {
        assert.deepStrictEqual(kinds(classifyLine('With obj')), ['open:with']);
        assert.deepStrictEqual(kinds(classifyLine('End With')), ['close:with']);
    });

    it('does not treat On Error Resume Next as a For closer', () => {
        assert.deepStrictEqual(classifyLine('On Error Resume Next'), []);
    });
});

// The squiggles and the matching-keyword highlight both ask about the document
// after every edit; the second asks about the text the first just scanned.
describe('scanAspStructure / getMatchedBlockPairs — one scan per text', () => {
    function doc(uri: string, text: string): vscode.TextDocument {
        const lines = text.split('\n');
        const lineOffsets: number[] = [];
        let acc = 0;
        for (const l of lines) { lineOffsets.push(acc); acc += l.length + 1; }
        return {
            uri:       { toString: () => uri },
            getText:   () => text,
            lineCount: lines.length,
            lineAt:    (i: number) => ({ text: lines[i] }),
            offsetAt:  (pos: vscode.Position) => lineOffsets[pos.line] + pos.character,
        } as unknown as vscode.TextDocument;
    }

    it('gives the second caller the scan the first one made', () => {
        const page = doc('file:///shared.asp', '<%\nIf x Then\n  y = 1\nEnd If\n%>');
        const first = getMatchedBlockPairs(page);
        assert.strictEqual(getMatchedBlockPairs(page), first);
    });

    it('scans again once the text has changed', () => {
        const before = doc('file:///edited.asp', '<%\nIf x Then\n  y = 1\nEnd If\n%>');
        const after  = doc('file:///edited.asp', '<%\nIf x Then\n  y = 1\n%>');
        assert.strictEqual(scanAspStructure(before).length, 0);
        assert.strictEqual(scanAspStructure(after).length, 1, 'the missing End If should be reported');
        assert.strictEqual(getMatchedBlockPairs(after).length, 0);
    });
});

// The HTML structure check reads the tags in each branch of an If or Select
// Case as alternatives, and finds the branches through these events.
describe('branchEvents', () => {
    const events = (code: string) => branchEvents(code).map(e => `${e.type}:${e.block}`);

    it('reads If / ElseIf / Else / End If', () => {
        assert.deepStrictEqual(events('If a = 1 Then'), ['open:if']);
        assert.deepStrictEqual(events('ElseIf a = 2 Then'), ['branch:if']);
        assert.deepStrictEqual(events('Else'), ['branch:if']);
        assert.deepStrictEqual(events('End If'), ['close:if']);
    });

    it('reads Select Case / Case / Case Else / End Select', () => {
        assert.deepStrictEqual(events('Select Case mode'), ['open:select']);
        assert.deepStrictEqual(events('Case 1, 2'), ['branch:select']);
        assert.deepStrictEqual(events('Case Else'), ['branch:select']);
        assert.deepStrictEqual(events('End Select'), ['close:select']);
    });

    it('gives a single-line If nothing', () => {
        assert.deepStrictEqual(events('If a Then b = 1 Else b = 2'), []);
    });

    it('reads every statement of a multi-line block in order', () => {
        assert.deepStrictEqual(events('x = 1\nIf a Then\n  y = 2\nElse : z = 3'), ['open:if', 'branch:if']);
    });

    it('ignores keywords in strings and comments', () => {
        assert.deepStrictEqual(events('msg = "End If" \' If a Then'), []);
    });

    it('reads an If whose condition runs over a line continuation', () => {
        assert.deepStrictEqual(events('If a And _\n   b Then'), ['open:if']);
    });
});

// IIS will not run a page whose #include names a file that is not there
// (ASP 0126), so the path is flagged where it is written.
describe('findMissingIncludes', () => {
    const site = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-includes-'));
    const page = path.join(site, 'admin', 'page.asp');
    before(() => {
        fs.mkdirSync(path.join(site, 'admin', 'lib'), { recursive: true });
        fs.mkdirSync(path.join(site, 'inc'));
        fs.writeFileSync(path.join(site, 'admin', 'lib', 'db.asp'), '');
        fs.writeFileSync(path.join(site, 'inc', 'header.asp'), '');
    });
    after(() => fs.rmSync(site, { recursive: true, force: true }));

    it('says nothing when every include is there', () => {
        const text = '<!--#include file="lib/db.asp"-->\n<!--#include virtual="/inc/header.asp"-->';
        assert.deepStrictEqual(findMissingIncludes(text, page, site), []);
    });

    it('flags a file include that is not there, on its path', () => {
        const text = '<p>\n<!-- #include file="lib/dbx.asp" -->';
        const [found, ...rest] = findMissingIncludes(text, page, site);
        assert.deepStrictEqual(rest, []);
        assert.strictEqual(text.slice(found.start, found.end), 'lib/dbx.asp');
        assert.ok(found.message.includes(path.join(site, 'admin', 'lib', 'dbx.asp')), found.message);
        assert.ok(found.message.includes('ASP 0126'), found.message);
    });

    it('resolves a file include from the page, not the site root', () => {
        const [found] = findMissingIncludes('<!--#include file="inc/header.asp"-->', page, site);
        assert.ok(found, 'inc/ is beside the site root, not beside the page');
    });

    it('flags a virtual include from the site root, and says where that is', () => {
        const [found] = findMissingIncludes('<!--#include virtual="/inc/footer.asp"-->', page, site);
        assert.ok(found.message.includes(path.join(site, 'inc', 'footer.asp')), found.message);
        assert.ok(found.message.includes('aspLanguageSupport.virtualRoot'), found.message);
    });

    it('leaves a virtual include alone when the site root is not known', () => {
        assert.deepStrictEqual(findMissingIncludes('<!--#include virtual="/inc/footer.asp"-->', page, undefined), []);
        assert.strictEqual(findMissingIncludes('<!--#include file="nope.asp"-->', page, undefined).length, 1);
    });

    it('flags a path that names a folder', () => {
        assert.strictEqual(findMissingIncludes('<!--#include file="lib"-->', page, site).length, 1);
    });

    it('points at the right one when the same path is written twice', () => {
        const text = '<!--#include file="a.asp"--><!--#include file="a.asp"-->';
        const found = findMissingIncludes(text, page, site);
        assert.deepStrictEqual(found.map(f => f.start), [19, 47]);
    });
});

// An object can only be assigned with Set. Without it VBScript tries to copy
// the object's default value, and for the objects flagged here that fails when
// the page runs — `rs = conn.Execute(sql)` is the classic one.
describe('findMissingSet', () => {
    const types = new Map([
        ['conn', 'adodb.connection'],
        ['rs', 'adodb.recordset'],
        ['fso', 'scripting.filesystemobject'],
        ['xml', 'msxml2.domdocument'],
    ]);
    const targets = (text: string) => findMissingSet(text, types).map(found => text.slice(found.start, found.end));

    it('flags a Recordset assigned without Set, on the name', () => {
        assert.deepStrictEqual(targets('<%\nrs = conn.Execute(sql)\n%>'), ['rs']);
        assert.deepStrictEqual(targets('<%\nSet rs = conn.Execute(sql)\n%>'), []);
    });

    it('flags CreateObject, Server.CreateObject and New', () => {
        assert.deepStrictEqual(targets('<% conn = Server.CreateObject("ADODB.Connection") %>'), ['conn']);
        assert.deepStrictEqual(targets('<% x = 1 : d = CreateObject("Scripting.Dictionary") %>'), ['d']);
        assert.deepStrictEqual(targets('<%\no = New Basket\nLet p = New Basket\n%>'), ['o', 'p']);
    });

    it('flags a function returning an object through its name', () => {
        const text = '<%\nFunction GetConn()\n  GetConn = Server.CreateObject("ADODB.Connection")\nEnd Function\n%>';
        assert.deepStrictEqual(targets(text), ['GetConn']);
    });

    it('flags other methods whose result has no value to copy', () => {
        assert.deepStrictEqual(targets('<%\nts = fso.OpenTextFile(Server.MapPath("/x"), 1)\n%>'), ['ts']);
        assert.deepStrictEqual(targets('<%\nnode = xml.selectSingleNode("//a")\n%>'), ['node']);
        assert.deepStrictEqual(targets('<%\nr2 = rs.NextRecordset\n%>'), ['r2']);
    });

    it('leaves a value read out of an object alone', () => {
        assert.deepStrictEqual(targets('<%\nn = conn.Execute("SELECT COUNT(*) FROM t")(0)\n%>'), []);
        assert.deepStrictEqual(targets('<%\nv = rs("name")\nw = rs.Fields("name")\n%>'), []);
        assert.deepStrictEqual(targets('<%\nx = CreateObject("a") & "b"\n%>'), []);
    });

    it('leaves an object whose default value is the point alone', () => {
        // A Folder's default is its Path.
        assert.deepStrictEqual(targets('<%\np = fso.GetFolder(".")\n%>'), []);
    });

    it('leaves a method on a variable of unknown type alone', () => {
        assert.deepStrictEqual(targets('<%\nrs = db.Execute(sql)\n%>'), []);
    });

    it('ignores comments, strings, comparisons, output expressions and markup', () => {
        assert.deepStrictEqual(targets("<%\n' rs = conn.Execute(sql)\nREM rs = conn.Execute(sql)\n%>"), []);
        assert.deepStrictEqual(targets('<%\nx = "rs = conn.Execute(sql)"\n%>'), []);
        assert.deepStrictEqual(targets('<%\nIf rs = conn.Execute(sql) Then\n%>'), []);
        assert.deepStrictEqual(targets('<%= x = CreateObject("a") %>'), []);
        assert.deepStrictEqual(targets('<p>rs = conn.Execute(sql)</p>\n<script>\nrs = conn.Execute(sql)\n</script>'), []);
    });

    it('finds one after Then on a one-line If, and one written over two lines', () => {
        assert.deepStrictEqual(targets('<%\nIf ok Then rs = conn.Execute(sql) Else x = 1\n%>'), ['rs']);
        assert.deepStrictEqual(targets('<%\nrs = _\n    conn.Execute(sql)\n%>'), ['rs']);
    });

    it('reads a server-side VBScript <script> block', () => {
        assert.deepStrictEqual(targets('<script runat="server" language="vbscript">\nrs = conn.Execute(sql)\n</script>'), ['rs']);
    });

    it('measures offsets over CRLF lines and several blocks on one line', () => {
        assert.deepStrictEqual(targets('<%\r\nrs = conn.Execute(sql)\r\n%>'), ['rs']);
        assert.deepStrictEqual(targets('<% x = 1 %><% rs = conn.Execute(sql) %>'), ['rs']);
    });
});
