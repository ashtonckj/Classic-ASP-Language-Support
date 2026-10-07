import * as assert from 'assert';
import { claimsAsp, competitorsToMention, findCompetitors } from '../../platform/competingExtensions';

// Two other Classic ASP extensions register the same language and grammar as
// this one, and then fight it over how .asp files are coloured. These pick
// them out of the installed extensions. The manifests are trimmed copies of
// what those two extensions declare.
const SYNTAXES = {
    id: 'jtjoo.classic-asp-html',
    packageJSON: {
        displayName: 'Classic ASP Syntaxes and Snippets',
        contributes: {
            languages: [{ id: 'asp', aliases: ['ASP', 'asp'], extensions: ['.asa', '.asp'] }],
            grammars:  [{ language: 'asp', scopeName: 'text.html.asp' }],
        },
    },
};
const CLASSIC_SUPPORT = {
    id: 'zbecknell.asp-classic-support',
    packageJSON: {
        displayName: 'ASP Classic Support',
        contributes: {
            languages: [{ id: 'vbs', extensions: ['.vbs'] }, { id: 'asp', extensions: ['.asa', '.asp', '.inc'] }],
            grammars:  [{ language: 'vbs', scopeName: 'source.vbs' }, { language: 'asp', scopeName: 'text.html.asp' }],
        },
    },
};
const SELF = {
    id: 'ashtonckj.classic-asp-language-support',
    packageJSON: { displayName: 'Classic ASP Language Support', contributes: { languages: [{ id: 'asp', extensions: ['.asp', '.inc'] }] } },
};
// VS Code's own HTML support lists .asp among its file types.
const HTML = { id: 'vscode.html', packageJSON: { displayName: 'HTML Language Basics', contributes: { languages: [{ id: 'html', extensions: ['.html', '.htm', '.asp', '.aspx'] }] } } };

describe('claimsAsp', () => {
    it('is true for an extension that registers the asp language', () => {
        assert.ok(claimsAsp(SYNTAXES.packageJSON));
        assert.ok(claimsAsp(CLASSIC_SUPPORT.packageJSON));
        assert.ok(claimsAsp({ contributes: { languages: [{ id: 'ASP' }] } }));
    });

    it('is true for one that only adds a grammar for the ASP scope', () => {
        assert.ok(claimsAsp({ contributes: { grammars: [{ scopeName: 'text.html.asp', path: './x.json' }] } }));
    });

    it('is false for one that only lists .asp among the files of another language', () => {
        assert.ok(!claimsAsp(HTML.packageJSON));
        assert.ok(!claimsAsp({ contributes: { languages: [{ id: 'html-templates', extensions: ['.asp', '.ejs'] }] } }));
    });

    it('is false for an extension that does not touch ASP files', () => {
        assert.ok(!claimsAsp({ contributes: { languages: [{ id: 'aspnet', extensions: ['.aspx'] }] } }));
    });

    it('does not throw on a manifest with no contributions', () => {
        assert.ok(!claimsAsp({}));
        assert.ok(!claimsAsp(undefined));
        assert.ok(!claimsAsp({ contributes: { languages: 'asp' } }));
    });
});

describe('findCompetitors', () => {
    it('names every other extension that claims ASP files, and never this one', () => {
        const found = findCompetitors([SELF, HTML, SYNTAXES, CLASSIC_SUPPORT], 'AshtonCKJ.classic-asp-language-support');
        assert.deepStrictEqual(found, [
            { id: 'jtjoo.classic-asp-html', name: 'Classic ASP Syntaxes and Snippets' },
            { id: 'zbecknell.asp-classic-support', name: 'ASP Classic Support' },
        ]);
    });

    it('never names one of the extensions built into VS Code', () => {
        const builtIn = { id: 'vscode.asp-preview', packageJSON: { contributes: { languages: [{ id: 'asp' }] } } };
        assert.deepStrictEqual(findCompetitors([builtIn], SELF.id), []);
    });

    it('falls back to the id when an extension has no display name', () => {
        const found = findCompetitors([{ id: 'someone.asp', packageJSON: { contributes: { languages: [{ id: 'asp' }] } } }], SELF.id);
        assert.deepStrictEqual(found, [{ id: 'someone.asp', name: 'someone.asp' }]);
    });
});

describe('competitorsToMention', () => {
    const found = findCompetitors([SYNTAXES, CLASSIC_SUPPORT], SELF.id);

    it('mentions all of them when nothing was answered before', () => {
        assert.strictEqual(competitorsToMention(found, [], 0, 1000).length, 2);
    });

    it('leaves out one the user chose to keep, without regard to case', () => {
        const mention = competitorsToMention(found, ['JTJOO.classic-asp-html'], 0, 1000);
        assert.deepStrictEqual(mention.map(c => c.id), ['zbecknell.asp-classic-support']);
    });

    it('stays quiet until a closed notification has waited its turn', () => {
        assert.strictEqual(competitorsToMention(found, [], 2000, 1000).length, 0);
        assert.strictEqual(competitorsToMention(found, [], 2000, 2000).length, 2);
    });
});
