import * as assert from 'assert';
import * as vscode from 'vscode';
import { migrateOldSettings } from '../../settingsMigration';

// 0.7.0 renamed the settings from aspLanguageSupport.* to classicAsp.*. A value
// someone set under an old name moves to the new one, and the old entry goes.
suite('Settings renamed to classicAsp (integration)', () => {
    const manifest = () => vscode.extensions.all.find(e => e.id.toLowerCase().endsWith('.classic-asp-language-support'))!.packageJSON;
    const global = vscode.ConfigurationTarget.Global;
    const inspect = (key: string) => vscode.workspace.getConfiguration().inspect(key)?.globalValue;

    teardown(async () => {
        const config = vscode.workspace.getConfiguration();
        for (const key of ['keywordCase', 'prettier.printWidth', 'highlightAspRegions']) {
            await config.update(`classicAsp.${key}`, undefined, global);
            await config.update(`aspLanguageSupport.${key}`, undefined, global);
        }
    });

    test('moves each old value to its new name and removes the old entry', async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update('aspLanguageSupport.keywordCase', 'UPPERCASE', global);
        await config.update('aspLanguageSupport.prettier.printWidth', 300, global);

        assert.strictEqual(await migrateOldSettings(manifest()), 2);

        assert.strictEqual(inspect('classicAsp.keywordCase'), 'UPPERCASE');
        assert.strictEqual(inspect('classicAsp.prettier.printWidth'), 300);
        assert.strictEqual(inspect('aspLanguageSupport.keywordCase'), undefined);
        assert.strictEqual(inspect('aspLanguageSupport.prettier.printWidth'), undefined);
    });

    test('keeps a value already set under the new name', async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update('aspLanguageSupport.highlightAspRegions', false, global);
        await config.update('classicAsp.highlightAspRegions', true, global);

        await migrateOldSettings(manifest());

        assert.strictEqual(inspect('classicAsp.highlightAspRegions'), true);
        assert.strictEqual(inspect('aspLanguageSupport.highlightAspRegions'), undefined);
    });

    test('does nothing when there is nothing to move', async () => {
        assert.strictEqual(await migrateOldSettings(manifest()), 0);
    });
});
