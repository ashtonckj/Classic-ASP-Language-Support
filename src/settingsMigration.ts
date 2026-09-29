/**
 * settingsMigration.ts
 *
 * The settings were renamed from `aspLanguageSupport.*` to `classicAsp.*` in
 * 0.7.0. On start-up, every value still set under an old name is moved to
 * its new name — in user, workspace and workspace-folder settings alike —
 * and the old entry removed, so nobody loses a setting they chose.
 *
 * The old names stay declared in package.json, marked as renamed, for one
 * reason: VS Code refuses to remove a setting that no extension declares.
 * The Settings editor hides a renamed setting unless it still has a value,
 * so once moved they are out of sight.
 */

import * as vscode from 'vscode';

const OLD_PREFIX = 'aspLanguageSupport.';
const NEW_PREFIX = 'classicAsp.';

/** The extension's package.json, as far as this reads it. */
interface Manifest { contributes?: { configuration?: { properties?: Record<string, unknown> }[] } }

/** The old setting names, read from the extension's own declarations. */
function oldKeys(manifest: Manifest): string[] {
    const sections = manifest.contributes?.configuration ?? [];
    return sections.flatMap(s => Object.keys(s.properties ?? {})).filter(key => key.startsWith(OLD_PREFIX));
}

type Place = { config: vscode.WorkspaceConfiguration; target: vscode.ConfigurationTarget; value: (i: ReturnType<vscode.WorkspaceConfiguration['inspect']>) => unknown };

/** Moves every value set under an old name. Resolves to how many were moved. */
export async function migrateOldSettings(manifest: Manifest): Promise<number> {
    const places: Place[] = [
        { config: vscode.workspace.getConfiguration(), target: vscode.ConfigurationTarget.Global,    value: i => i?.globalValue },
        { config: vscode.workspace.getConfiguration(), target: vscode.ConfigurationTarget.Workspace, value: i => i?.workspaceValue },
        ...(vscode.workspace.workspaceFolders ?? []).map(folder => ({
            config: vscode.workspace.getConfiguration(undefined, folder.uri),
            target: vscode.ConfigurationTarget.WorkspaceFolder,
            value:  (i: ReturnType<vscode.WorkspaceConfiguration['inspect']>) => i?.workspaceFolderValue,
        })),
    ];

    let moved = 0;
    for (const oldKey of oldKeys(manifest)) {
        const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length);
        for (const place of places) {
            const oldValue = place.value(place.config.inspect(oldKey));
            if (oldValue === undefined) { continue; }
            try {
                // A value already set under the new name was chosen later; it wins.
                if (place.value(place.config.inspect(newKey)) === undefined) {
                    await place.config.update(newKey, oldValue, place.target);
                }
                await place.config.update(oldKey, undefined, place.target);
                moved++;
            } catch {
                // A settings file that cannot be written (read-only, invalid
                // JSON) keeps its old entry; the next start tries again.
            }
        }
    }
    return moved;
}

/** Moves the old settings, and says so when there were any. */
export async function migrateOldSettingsAndTell(context: vscode.ExtensionContext): Promise<void> {
    const moved = await migrateOldSettings(context.extension.packageJSON);
    if (moved === 0) { return; }
    const open = 'Show Settings';
    const choice = await vscode.window.showInformationMessage(
        `Classic ASP: the settings are now called classicAsp.… instead of aspLanguageSupport.…. ` +
        `Your ${moved === 1 ? 'setting was' : `${moved} settings were`} moved to the new names, with the same values.`,
        open,
    );
    if (choice === open) { void vscode.commands.executeCommand('workbench.action.openSettings', 'classicAsp'); }
}
