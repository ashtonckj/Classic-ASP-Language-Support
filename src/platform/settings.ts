/**
 * settings.ts
 *
 * Every `classicAsp.*` setting is read here and nowhere else, typed, and with
 * the default package.json declares, so the code and the Settings editor
 * cannot disagree about what an unset setting means.
 *
 * Settings that belong to VS Code or another extension (`emmet.*`, `html.*`,
 * `files.associations`) are read through `otherSetting`, so there is still one
 * place to look. settingsMigration.ts is the one exception: it moves raw values
 * from the old setting names to the new ones, so it inspects them itself.
 */

import * as path from 'path';
import * as vscode from 'vscode';

// ── Defaults, from package.json ───────────────────────────────────────────────

interface ConfigurationSection { properties: Record<string, { default?: unknown }> }

// package.json sits two folders up from this file, in src/ and in out/ alike.
const manifest = require(path.join(__dirname, '..', '..', 'package.json')) as {
    contributes: { configuration: ConfigurationSection | ConfigurationSection[] };
};

const DEFAULTS: ReadonlyMap<string, unknown> = new Map(
    ([] as ConfigurationSection[]).concat(manifest.contributes.configuration)
        .flatMap(section => Object.entries(section.properties).map(([key, property]) => [key, property.default] as const)),
);

/** A `classicAsp.*` setting as the user set it, or its package.json default. */
function read<T>(key: string): T {
    const value = vscode.workspace.getConfiguration().get<T>(key);
    return (value === undefined ? DEFAULTS.get(key) : value) as T;
}

// ── The settings, by group ────────────────────────────────────────────────────

export interface FormatterSettings {
    keywordCase:       'lowercase' | 'UPPERCASE' | 'PascalCase';
    aspTagsOnSameLine: boolean;
    htmlIndentMode:    'flat' | 'continuation';
}

export function formatterSettings(): FormatterSettings {
    return {
        keywordCase:       read('classicAsp.keywordCase'),
        aspTagsOnSameLine: read('classicAsp.aspTagsOnSameLine'),
        htmlIndentMode:    read('classicAsp.htmlIndentMode'),
    };
}

export interface PrettierSettings {
    printWidth:                number;
    tabWidth:                  number;
    useTabs:                   boolean;
    semi:                      boolean;
    singleQuote:               boolean;
    bracketSameLine:           boolean;
    arrowParens:               string;
    trailingComma:             string;
    endOfLine:                 string;
    htmlWhitespaceSensitivity: string;
}

export function prettierSettings(): PrettierSettings {
    return {
        printWidth:                read('classicAsp.prettier.printWidth'),
        tabWidth:                  read('classicAsp.prettier.tabWidth'),
        useTabs:                   read('classicAsp.prettier.useTabs'),
        semi:                      read('classicAsp.prettier.semi'),
        singleQuote:               read('classicAsp.prettier.singleQuote'),
        bracketSameLine:           read('classicAsp.prettier.bracketSameLine'),
        arrowParens:               read('classicAsp.prettier.arrowParens'),
        trailingComma:             read('classicAsp.prettier.trailingComma'),
        endOfLine:                 read('classicAsp.prettier.endOfLine'),
        htmlWhitespaceSensitivity: read('classicAsp.prettier.htmlWhitespaceSensitivity'),
    };
}

export interface RegionSettings {
    enabled:        boolean;
    bracketLight:   string;
    bracketDark:    string;
    codeBlockLight: string;
    codeBlockDark:  string;
}

/** The settings behind the `<% %>` region colours, for `onSettingsChange`. */
export const REGION_SETTING_KEYS = [
    'classicAsp.highlightAspRegions',
    'classicAsp.bracketLightColor',
    'classicAsp.bracketDarkColor',
    'classicAsp.codeBlockLightColor',
    'classicAsp.codeBlockDarkColor',
] as const;

export function regionSettings(): RegionSettings {
    return {
        enabled:        read('classicAsp.highlightAspRegions'),
        bracketLight:   read('classicAsp.bracketLightColor'),
        bracketDark:    read('classicAsp.bracketDarkColor'),
        codeBlockLight: read('classicAsp.codeBlockLightColor'),
        codeBlockDark:  read('classicAsp.codeBlockDarkColor'),
    };
}

/** `classicAsp.virtualRoot`, trimmed; empty when unset. */
export function virtualRootSetting(): string {
    return (read<string>('classicAsp.virtualRoot') ?? '').trim();
}

/** `classicAsp.defaultIncludes`, as written. */
export function defaultIncludesSetting(): string[] {
    return read<string[]>('classicAsp.defaultIncludes') ?? [];
}

// ── Settings of VS Code and other extensions ─────────────────────────────────

/** A setting outside `classicAsp`, such as `emmet.triggerExpansionOnTab`; undefined when unset and undeclared. */
export function otherSetting<T>(section: string, key: string, scope?: vscode.ConfigurationScope): T | undefined {
    return vscode.workspace.getConfiguration(section, scope).get<T>(key);
}

// ── Changes ───────────────────────────────────────────────────────────────────

/** True when a settings change touches any of `keys` (full names, such as `classicAsp.virtualRoot`). */
export function affectsSettings(event: { affectsConfiguration(section: string): boolean }, keys: readonly string[]): boolean {
    return keys.some(key => event.affectsConfiguration(key));
}

/** Calls `listener` whenever any of `keys` changes. */
export function onSettingsChange(keys: readonly string[], listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(event => {
        if (affectsSettings(event, keys)) { listener(); }
    });
}
