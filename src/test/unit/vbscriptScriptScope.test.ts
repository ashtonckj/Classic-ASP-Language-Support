import * as assert from 'assert';
import * as path from 'path';
import { buildScriptScope, type ScopeHost } from '../../vbscript/scriptScope';
import { resolveIncludeDirective } from '../../utils/includeDirectives';

/** A host over an in-memory site, with the site root as the virtual root. */
function site(files: Record<string, string>): ScopeHost & { reads: string[] } {
    const root = path.resolve('/site');
    const reads: string[] = [];
    return {
        reads,
        read: p => {
            reads.push(p);
            const rel = path.relative(root, p).replace(/\\/g, '/');
            return rel in files ? files[rel] : null;
        },
        resolve: (d, from) => resolveIncludeDirective(d, from, root),
    };
}

const at = (p: string) => path.resolve('/site', p);

describe('buildScriptScope', () => {
    it('reads a page and its includes in the order IIS pastes them', () => {
        const host = site({
            'inc/a.inc': '<% Dim a %><!-- #include file="b.inc" --><% a = 1 %>',
            'inc/b.inc': '<% Dim b %>',
        });
        const text = '<% Dim p %><!-- #include virtual="/inc/a.inc" --><% p = 2 %>';
        const scope = buildScriptScope(at('page.asp'), text, host);

        assert.deepStrictEqual(scope.files.map(f => path.basename(f.path)), ['page.asp', 'a.inc', 'b.inc']);
        assert.deepStrictEqual(
            scope.chunks.map(c => `${path.basename(c.file.path)}:${c.file.text.slice(c.start, c.end)}`),
            ['page.asp:<% Dim p %>', 'a.inc:<% Dim a %>', 'b.inc:<% Dim b %>', 'a.inc:<% a = 1 %>', 'page.asp:<% p = 2 %>'],
        );
        assert.deepStrictEqual(scope.problems, []);
    });

    it('reports an include that is missing, includes itself, or comes twice', () => {
        const host = site({
            'loop.inc': '<!-- #include file="loop.inc" -->',
            'once.inc': '<% Dim o %>',
        });
        const text = [
            '<!-- #include file="gone.inc" -->',
            '<!-- #include file="loop.inc" -->',
            '<!-- #include file="once.inc" -->',
            '<!-- #include file="once.inc" -->',
        ].join('\n');
        const messages = buildScriptScope(at('page.asp'), text, host).problems.map(p => p.message.replace(/: .*gone/, ': gone'));
        assert.deepStrictEqual(messages, [
            'Include file not found: gone.inc',
            "The include file 'loop.inc' includes itself",
            "'once.inc' is already included on this page",
        ]);
    });

    it('counts the default includes as included at the top of the page', () => {
        const host = { ...site({ 'lib.asp': '<% Dim lib %>' }), defaultIncludes: () => [at('lib.asp'), at('gone.asp'), at('page.asp')] };
        const scope = buildScriptScope(at('page.asp'), '<!-- #include file="lib.asp" --><% Dim p %>', host);
        assert.deepStrictEqual(
            scope.chunks.map(c => `${path.basename(c.file.path)}:${c.file.text.slice(c.start, c.end)}`),
            ['lib.asp:<% Dim lib %>', 'page.asp:<% Dim p %>'],
        );
        assert.deepStrictEqual(scope.problems, []);
    });

    it('reads each file once, however often it is included', () => {
        const host = site({ 'x.inc': '<% Dim x %>' });
        buildScriptScope(at('page.asp'), '<!-- #include file="x.inc" --><!-- #include file="x.inc" -->', host);
        assert.strictEqual(host.reads.length, 1);
    });
});
