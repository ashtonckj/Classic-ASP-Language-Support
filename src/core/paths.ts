/**
 * paths.ts  (core/)
 *
 * How a file path is compared and looked up. Windows paths are not case
 * sensitive, and IIS serves `Inc/DB.asp` for `inc/db.asp`, so every map of
 * files is keyed by pathKey, on the extension host and on the workers alike.
 */

import * as fs from 'fs';

/** The key a file is stored under in any map of files: its path, lower-cased. */
export function pathKey(fsPath: string): string {
    return fsPath.toLowerCase();
}

/** True when the two paths name the same file. */
export function samePath(a: string, b: string): boolean {
    return pathKey(a) === pathKey(b);
}

/**
 * True when `fsPath` is a file that exists. A synchronous disk read: for
 * commands and checks that run now and then, never in a per-keystroke path.
 */
export function isFile(fsPath: string): boolean {
    try { return fs.statSync(fsPath).isFile(); } catch { return false; }
}
