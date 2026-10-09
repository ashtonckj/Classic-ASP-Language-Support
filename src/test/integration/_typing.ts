import * as vscode from 'vscode';

/**
 * Types `text` into the active editor, as a keystroke would.
 *
 * The `type` command goes to whatever has focus, and in a test window that is
 * not always the editor — the chat input took the keystrokes once. So the
 * editor group is focused first, every time.
 */
export async function typeText(text: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('type', { text });
}
