import * as assert from 'assert';
import * as path from 'path';
import {
    affectsSettings, defaultIncludesSetting, formatterSettings, prettierSettings, REGION_SETTING_KEYS,
    regionSettings, virtualRootSetting,
} from '../../platform/settings';

// The unit stub's configuration holds no values, so every setting reads as the
// default package.json declares, exactly as an unset setting does in VS Code.
const manifest = require(path.join(__dirname, '..', '..', '..', 'package.json'));
const declared = (key: string) => ([] as { properties: Record<string, { default?: unknown }> }[])
    .concat(manifest.contributes.configuration)
    .find(section => key in section.properties)!.properties[key].default;

describe('settings — an unset setting reads as its package.json default', () => {
    it('reads the formatter, Prettier, region and include settings', () => {
        assert.deepStrictEqual(formatterSettings(), {
            keywordCase:       declared('classicAsp.keywordCase'),
            aspTagsOnSameLine: declared('classicAsp.aspTagsOnSameLine'),
            htmlIndentMode:    declared('classicAsp.htmlIndentMode'),
        });
        const prettier = prettierSettings();
        for (const [key, value] of Object.entries(prettier)) {
            assert.deepStrictEqual(value, declared(`classicAsp.prettier.${key}`), key);
        }
        assert.strictEqual(regionSettings().enabled, declared('classicAsp.highlightAspRegions'));
        assert.strictEqual(regionSettings().codeBlockDark, declared('classicAsp.codeBlockDarkColor'));
        assert.strictEqual(virtualRootSetting(), '');
        assert.deepStrictEqual(defaultIncludesSetting(), []);
    });
});

// The region colours were rebuilt on every settings change of any kind.
describe('affectsSettings', () => {
    const change = (...touched: string[]) => ({
        affectsConfiguration: (section: string) => touched.some(t => t === section || t.startsWith(section + '.')),
    });

    it('is true for the region on/off switch and each colour', () => {
        assert.strictEqual(affectsSettings(change('classicAsp.highlightAspRegions'), REGION_SETTING_KEYS), true);
        assert.strictEqual(affectsSettings(change('classicAsp.codeBlockDarkColor'), REGION_SETTING_KEYS), true);
    });

    it("is false for any other setting, this extension's included", () => {
        assert.strictEqual(affectsSettings(change('editor.fontSize'), REGION_SETTING_KEYS), false);
        assert.strictEqual(affectsSettings(change('classicAsp.keywordCase'), REGION_SETTING_KEYS), false);
    });
});
