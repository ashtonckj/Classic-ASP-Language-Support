import * as assert from 'assert';
import {
    ASP_OBJECTS, ASP_OBJECT_NAMES, ASP_MEMBER_DOCS,
    VBSCRIPT_KEYWORDS, VBSCRIPT_FUNCTIONS, VBSCRIPT_CONSTANTS,
} from '../../constants/aspKeywords';
import { isReservedWord } from '../../vbscript/parser';

// The intrinsic objects used to be listed with four or five members each, so
// ordinary code — Response.CharSet, Response.ContentType, Server.Transfer,
// Request.BinaryRead — had no completion and no hover, and nothing told the
// extension it was part of the language rather than a variable someone made up.
//
// These tests are mostly about the data staying coherent: a member missing a
// doc, a duplicate, or an object added to the list but not to the derived
// lookups would all be silent failures.

/** Members every Classic ASP page uses, which the original list did not have. */
const MUST_EXIST: Array<[string, string]> = [
    ['Response', 'Charset'],
    ['Response', 'ContentType'],
    ['Response', 'Buffer'],
    ['Response', 'Status'],
    ['Response', 'Expires'],
    ['Response', 'CacheControl'],
    ['Response', 'AddHeader'],
    ['Response', 'BinaryWrite'],
    ['Response', 'IsClientConnected'],
    ['Request', 'ServerVariables'],
    ['Request', 'TotalBytes'],
    ['Request', 'BinaryRead'],
    ['Request', 'ClientCertificate'],
    ['Server', 'Transfer'],
    ['Server', 'Execute'],
    ['Server', 'GetLastError'],
    ['Server', 'ScriptTimeout'],
    ['Session', 'SessionID'],
    ['Session', 'Timeout'],
    ['Session', 'LCID'],
    ['Session', 'CodePage'],
    ['Application', 'StaticObjects'],
    ['ASPError', 'Number'],
    ['ASPError', 'Description'],
    ['ObjectContext', 'SetAbort'],
    // Err is VBScript's rather than ASP's, but it reaches the editor the same
    // way, and `On Error Resume Next` was in the keyword list with nothing to
    // pair it with — the page could be told how to start ignoring errors and
    // then had no idea what `Err.Number` was.
    ['Err', 'Number'],
    ['Err', 'Description'],
    ['Err', 'Source'],
    ['Err', 'Clear'],
    ['Err', 'Raise'],
];

describe('ASP intrinsic objects — coverage', () => {

    it('has every object that is in scope without being created', () => {
        assert.deepStrictEqual(
            ASP_OBJECTS.map(o => o.name).sort(),
            ['ASPError', 'Application', 'Err', 'ObjectContext', 'Request', 'Response', 'Server', 'Session'],
        );
    });

    for (const [object, member] of MUST_EXIST) {
        it(`knows ${object}.${member}`, () => {
            const def = ASP_OBJECTS.find(o => o.name === object);
            assert.ok(def, `${object} is missing`);
            assert.ok(
                def.members.some(m => m.name === member),
                `${object}.${member} is missing`,
            );
        });
    }
});

describe('ASP intrinsic objects — the data holds together', () => {

    it('gives every member a kind and a non-empty doc', () => {
        for (const object of ASP_OBJECTS) {
            for (const member of object.members) {
                assert.ok(
                    ['method', 'property', 'collection'].includes(member.kind),
                    `${object.name}.${member.name} has kind ${member.kind}`,
                );
                assert.ok(
                    member.doc.trim().length > 0,
                    `${object.name}.${member.name} has no doc`,
                );
            }
        }
    });

    it('lists no member twice within an object', () => {
        for (const object of ASP_OBJECTS) {
            const seen = new Set<string>();
            for (const member of object.members) {
                const key = member.name.toLowerCase();
                assert.ok(!seen.has(key), `${object.name}.${member.name} is listed twice`);
                seen.add(key);
            }
        }
    });

    it('derives ASP_OBJECT_NAMES from the list', () => {
        assert.strictEqual(ASP_OBJECT_NAMES.size, ASP_OBJECTS.length);
        for (const object of ASP_OBJECTS) {
            assert.ok(ASP_OBJECT_NAMES.has(object.name.toLowerCase()), object.name);
        }
    });

    it('derives one ASP_MEMBER_DOCS entry per member, keyed case-insensitively', () => {
        const total = ASP_OBJECTS.reduce((n, o) => n + o.members.length, 0);
        assert.strictEqual(Object.keys(ASP_MEMBER_DOCS).length, total);

        const charset = ASP_MEMBER_DOCS['response.charset'];
        assert.ok(charset, 'response.charset should be in the lookup');
        assert.strictEqual(charset.label, 'Response.Charset');
        assert.strictEqual(charset.kind, 'property');
    });

    it('marks the indexed members as collections, not properties', () => {
        for (const key of ['request.form', 'request.querystring', 'request.servervariables',
                           'response.cookies', 'session.contents', 'application.contents']) {
            assert.strictEqual(ASP_MEMBER_DOCS[key].kind, 'collection', key);
        }
    });

    it('does not offer Remove or RemoveAll directly on Session', () => {
        // They live on the Contents collection — `Session.Contents.Remove("k")`.
        // The old list had them on Session itself, which is not valid VBScript.
        const session = ASP_OBJECTS.find(o => o.name === 'Session');
        assert.ok(session);
        for (const wrong of ['Remove', 'RemoveAll']) {
            assert.ok(
                !session.members.some(m => m.name === wrong),
                `Session.${wrong} is not a real member`,
            );
        }
    });
});

// One list says which words can never be a name, checked against cscript:
// `Dim <word>` fails for each word it holds and compiles for each it does not.
describe('VBScript reserved words', () => {

    it('holds every word cscript refuses to Dim, Integer and Enum included', () => {
        for (const word of ['end', 'if', 'select', 'case', 'option', 'on', 'resume', 'next', 'each', 'get',
                            'preserve', 'byref', 'me', 'rem', 'stop', 'integer', 'enum', 'variant', 'static']) {
            assert.ok(isReservedWord(word), `${word} should be reserved`);
        }
    });

    it('leaves out the words cscript lets a page declare', () => {
        for (const word of ['step', 'error', 'property', 'explicit', 'default', 'erase', 'randomize', 'alias', 'object']) {
            assert.ok(!isReservedWord(word), `${word} is a legal name`);
        }
    });
});

describe('VBScript keyword list', () => {

    it('lists no keyword twice', () => {
        const seen = new Set<string>();
        for (const { keyword } of VBSCRIPT_KEYWORDS) {
            const key = keyword.toLowerCase();
            assert.ok(!seen.has(key), `${keyword} is listed twice`);
            seen.add(key);
        }
    });
});

describe('VBScript functions and constants', () => {

    it('knows the functions the list was missing', () => {
        for (const fn of ['Eval', 'Execute', 'ExecuteGlobal', 'GetRef', 'GetLocale',
                          'SetLocale', 'Escape', 'Unescape', 'AscW', 'ChrW',
                          'ScriptEngine', 'ScriptEngineMajorVersion']) {
            assert.ok(VBSCRIPT_FUNCTIONS.includes(fn), `${fn} is missing`);
        }
    });

    it('lists no function twice, ignoring case', () => {
        const seen = new Set<string>();
        for (const fn of VBSCRIPT_FUNCTIONS) {
            const key = fn.toLowerCase();
            assert.ok(!seen.has(key), `${fn} is listed twice`);
            seen.add(key);
        }
    });

    it('offers the string constants a page actually writes', () => {
        for (const name of ['vbCrLf', 'vbTab', 'vbNewLine', 'vbNullString', 'vbObjectError']) {
            assert.ok(VBSCRIPT_CONSTANTS.some(c => c.name === name), `${name} is missing`);
        }
    });

    it('gives every constant a non-empty doc and lists none twice', () => {
        const seen = new Set<string>();
        for (const { name, doc } of VBSCRIPT_CONSTANTS) {
            assert.ok(doc.trim().length > 0, `${name} has no doc`);
            assert.ok(!seen.has(name.toLowerCase()), `${name} is listed twice`);
            seen.add(name.toLowerCase());
        }
    });
});
