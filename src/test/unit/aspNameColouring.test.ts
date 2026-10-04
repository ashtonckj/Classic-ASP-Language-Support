import * as assert from 'assert';
import { colourAspPage } from '../../utils/aspColouring';
import { COMBINED_SEMANTIC_LEGEND } from '../../providers/jsSemanticProvider';
import type { FileSymbols } from '../../utils/symbolParser';

// VBScript names are coloured from the binder: each is coloured as what it
// refers to in VBScript's own scopes, not by matching the word against every
// name declared anywhere on the page.

const TYPES = COMBINED_SEMANTIC_LEGEND.tokenTypes;
const NO_INCLUDES: FileSymbols = { variables: [], constants: [], functions: [], comVariables: [], classes: [] };

/** Each coloured name as "line:word type", SQL left out. */
function names(text: string, includeSymbols: FileSymbols = NO_INCLUDES): string[] {
    const { tokens } = colourAspPage({ id: 1, text, docPath: 'C:\\site\\page.asp', includeSymbols });
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i + 4 < tokens.length; i += 5) {
        const type = TYPES[tokens[i + 3]];
        if (type.startsWith('sql')) { continue; }
        out.push(`${tokens[i]}:${lines[tokens[i]].substr(tokens[i + 1], tokens[i + 2])} ${type}`);
    }
    return out.sort();
}

describe('VBScript name colouring', () => {
    it('colours a variable, a constant, a Function, a Sub and a parameter as what they are', () => {
        const page = '<%\nDim total\nConst MAX = 3\nFunction Twice(n)\n  Twice = n * 2\nEnd Function\nSub Show()\nEnd Sub\ntotal = Twice(MAX)\nShow\n%>';
        assert.deepStrictEqual(names(page), [
            '1:total variable', '2:MAX enumMember',
            '3:Twice function', '3:n parameter', '4:Twice function', '4:n parameter',
            '6:Show namespace', '8:MAX enumMember', '8:Twice function', '8:total variable', '9:Show namespace',
        ].sort());
    });

    it('leaves a member alone, even when the page has a name like it', () => {
        const page = '<%\nDim count\nSub Add(x)\nEnd Sub\nn = dict.Count\ndict.Add "a", 1\n%>';
        const found = names(page);
        assert.ok(!found.includes('4:Count variable'), JSON.stringify(found));
        assert.ok(!found.some(n => n.startsWith('5:Add')), JSON.stringify(found));
    });

    it('keeps a parameter to its own procedure', () => {
        const page = '<%\nSub A(item)\n  item = 1\nEnd Sub\nitem = 2\n%>';
        const found = names(page);
        assert.ok(found.includes('2:item parameter'), JSON.stringify(found));
        assert.ok(found.includes('4:item variable'), JSON.stringify(found));
    });

    it('colours a For loop counter', () => {
        assert.ok(names('<%\nFor i = 1 To 3\n  Response.Write i\nNext\n%>').includes('2:i variable'));
    });

    it('never colours a word inside a string or a comment', () => {
        const page = '<%\nDim total\nx = "total" \' total\n%>';
        assert.deepStrictEqual(names(page).filter(n => n.includes('total')), ['1:total variable']);
    });

    it('colours a name an include declares', () => {
        const includes: FileSymbols = {
            ...NO_INCLUDES,
            functions: [{ name: 'OpenDb', kind: 'Function', params: '', paramNames: [], line: 0, endLine: 0, filePath: 'C:\\site\\db.inc' }],
            constants: [{ name: 'DB_NAME', value: '"x"', line: 0, filePath: 'C:\\site\\db.inc' }],
        };
        const found = names('<%\nx = OpenDb(DB_NAME)\n%>', includes);
        assert.ok(found.includes('1:OpenDb function') && found.includes('1:DB_NAME enumMember'), JSON.stringify(found));
    });
});

// global.asa, and some pages, declare objects with tags rather than Dim.
describe('VBScript name colouring — <object runat="server"> tags', () => {
    it('colours an object a tag declares as a variable', () => {
        const page = '<object runat="Server" scope="Application" id="AppDict" progid="Scripting.Dictionary"></object>\n<script language="VBScript" runat="Server">\nSub Application_OnStart\n  AppDict.Add "a", 1\nEnd Sub\n</script>';
        assert.ok(names(page).includes('3:AppDict variable'), JSON.stringify(names(page)));
    });
});
