import * as assert from 'assert';
import {
    COM_TYPE_MAP, COM_MEMBER_DOCS, COM_METHOD_RETURN_TYPES, normalizeProgId,
} from '../../constants/comObjects';

// A COM type this extension does not know is worse than an untyped variable,
// not merely uncovered: `aspCompletionProvider` answers a dotted access on a
// KNOWN variable with an empty list, deliberately, so that keywords do not
// pollute a member list. So the moment a variable is typed, the type has to
// exist — which is what these tests are mostly about.

describe('COM types — the graph closes', () => {

    it('every inferred return type has a definition', () => {
        // This was broken for all six entries: OpenTextFile inferred
        // scripting.textstream, GetFile inferred scripting.file, SelectNodes
        // inferred msxml2.nodelist, and none of the three existed. Typing
        // `ts.` after `Set ts = fso.OpenTextFile(p)` therefore offered nothing
        // at all, where an unrecognised variable would at least have offered
        // the ordinary completions.
        for (const [method, returns] of Object.entries(COM_METHOD_RETURN_TYPES)) {
            assert.ok(
                COM_TYPE_MAP[returns],
                `${method} infers ${returns}, which has no definition`,
            );
        }
    });

    it('every inferred return type is keyed on a type that exists', () => {
        for (const key of Object.keys(COM_METHOD_RETURN_TYPES)) {
            const owner = key.slice(0, key.lastIndexOf('.'));
            assert.ok(
                COM_TYPE_MAP[owner],
                `${key} is keyed on ${owner}, which has no definition`,
            );
        }
    });

    it('every inferred return type names a method the owner actually has', () => {
        for (const key of Object.keys(COM_METHOD_RETURN_TYPES)) {
            const owner  = key.slice(0, key.lastIndexOf('.'));
            const method = key.slice(key.lastIndexOf('.') + 1);
            assert.ok(
                COM_TYPE_MAP[owner].members.some(m => m.name.toLowerCase() === method),
                `${owner} has no member ${method}`,
            );
        }
    });
});

describe('COM types — the data holds together', () => {

    it('gives every member a non-empty doc', () => {
        for (const [progId, typeDef] of Object.entries(COM_TYPE_MAP)) {
            for (const member of typeDef.members) {
                assert.ok(
                    member.doc.trim().length > 0,
                    `${progId}.${member.name} has no doc`,
                );
            }
        }
    });

    it('lists no member twice within a type', () => {
        for (const [progId, typeDef] of Object.entries(COM_TYPE_MAP)) {
            const seen = new Set<string>();
            for (const member of typeDef.members) {
                const key = member.name.toLowerCase();
                assert.ok(!seen.has(key), `${progId}.${member.name} is listed twice`);
                seen.add(key);
            }
        }
    });

    it('derives one COM_MEMBER_DOCS entry per member', () => {
        const total = Object.values(COM_TYPE_MAP)
            .reduce((n, t) => n + t.members.length, 0);
        assert.strictEqual(Object.keys(COM_MEMBER_DOCS).length, total);
        assert.strictEqual(
            COM_MEMBER_DOCS['adodb.recordset.movenext'].label,
            'ADODB.Recordset.MoveNext',
        );
    });

    it('spells the recordset cursor methods the way ADO does', () => {
        // The list carried `MovePrev`, which is not a member of anything — ADO
        // and DAO both spell it MovePrevious. It was offered as a completion
        // and hovered as real, so it read as confirmation rather than a typo.
        const members = COM_TYPE_MAP['adodb.recordset'].members.map(m => m.name);
        for (const name of ['MoveFirst', 'MoveLast', 'MoveNext', 'MovePrevious']) {
            assert.ok(members.includes(name), `ADODB.Recordset.${name} is missing`);
        }
        assert.ok(!members.includes('MovePrev'), 'MovePrev is not an ADO member');
    });
});

describe('COM types — coverage a Classic ASP page expects', () => {

    const MUST_EXIST: Array<[string, string]> = [
        ['scripting.textstream',       'ReadAll'],
        ['scripting.textstream',       'AtEndOfStream'],
        ['scripting.textstream',       'WriteLine'],
        ['scripting.file',             'DateLastModified'],
        ['scripting.folder',           'SubFolders'],
        ['scripting.drive',            'FreeSpace'],
        ['adodb.stream',               'SaveToFile'],
        ['adodb.stream',               'ReadText'],
        ['adodb.field',                'Value'],
        ['adodb.parameter',            'Direction'],
        ['adodb.error',                'NativeError'],
        ['adodb.recordset',            'GetRows'],
        ['adodb.recordset',            'Filter'],
        ['adodb.connection',           'Provider'],
        ['scripting.filesystemobject', 'CreateFolder'],
        ['scripting.filesystemobject', 'GetExtensionName'],
        ['scripting.dictionary',       'Key'],
        // Every DOMDocument example sets this, and getting it wrong means the
        // page carries on before the document has loaded.
        ['msxml2.domdocument',         'Async'],
        ['msxml2.ixmldomnode',         'ChildNodes'],
        ['msxml2.ixmldomnodelist',     'Length'],
        ['msxml2.serverxmlhttp',       'SetTimeouts'],
        ['msxml2.serverxmlhttp',       'ResponseBody'],
        ['cdo.message',                'HTMLBody'],
        ['cdonts.newmail',             'BodyFormat'],
    ];

    for (const [progId, member] of MUST_EXIST) {
        it(`knows ${progId}.${member}`, () => {
            const typeDef = COM_TYPE_MAP[progId];
            assert.ok(typeDef, `${progId} has no definition`);
            assert.ok(
                typeDef.members.some(m => m.name === member),
                `${progId}.${member} is missing`,
            );
        });
    }
});

describe('ProgID normalisation', () => {

    // The recommended spelling pins a version, and the raw string was the
    // lookup key — so the form Microsoft's own documentation uses was the one
    // that resolved to nothing.
    const CASES: Array<[string, string]> = [
        ['MSXML2.DOMDocument.6.0',              'msxml2.domdocument'],
        ['MSXML2.DOMDocument.3.0',              'msxml2.domdocument'],
        ['MSXML2.ServerXMLHTTP.6.0',            'msxml2.serverxmlhttp'],
        ['ADODB.Connection.1',                  'adodb.connection'],
        ['ADODB.Recordset',                     'adodb.recordset'],
        ['Microsoft.XMLHTTP',                   'msxml2.serverxmlhttp'],
        ['Microsoft.XMLDOM',                    'msxml2.domdocument'],
        ['MSXML2.FreeThreadedDOMDocument.6.0',  'msxml2.domdocument'],
        ['  Scripting.Dictionary  ',            'scripting.dictionary'],
        ['SCRIPTING.FILESYSTEMOBJECT',          'scripting.filesystemobject'],
    ];

    for (const [written, expected] of CASES) {
        it(`resolves ${written.trim()}`, () => {
            const normalized = normalizeProgId(written);
            assert.strictEqual(normalized, expected);
            assert.ok(COM_TYPE_MAP[normalized], `${normalized} has no definition`);
        });
    }

    it('keeps a non-numeric last component', () => {
        // The version suffix is always numeric, so the rule cannot be "drop the
        // last component" — that would turn Scripting.Dictionary into Scripting.
        assert.strictEqual(normalizeProgId('Scripting.Dictionary'), 'scripting.dictionary');
        assert.strictEqual(normalizeProgId('ADODB.Stream'), 'adodb.stream');
    });

    it('leaves an unknown ProgID alone rather than guessing', () => {
        assert.strictEqual(normalizeProgId('Persits.Upload'), 'persits.upload');
        assert.strictEqual(normalizeProgId('SoftArtisans.FileUp.1'), 'softartisans.fileup');
    });

    it('resolves every alias to a type that exists', () => {
        for (const progId of ['Microsoft.XMLHTTP', 'Microsoft.XMLDOM',
                              'MSXML2.XMLHTTP', 'MSXML.DOMDocument',
                              'MSXML2.FreeThreadedDOMDocument']) {
            assert.ok(
                COM_TYPE_MAP[normalizeProgId(progId)],
                `${progId} resolves to something undefined`,
            );
        }
    });
});
