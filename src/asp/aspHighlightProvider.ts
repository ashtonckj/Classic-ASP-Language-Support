import * as vscode from 'vscode';
import { resolveAt, sitesIn } from '../vbscript/references';
import { editorWorkspace } from './vbscriptWorkspace';
import { wordAt } from './aspRenameProvider';
import { pathKey } from '../core/paths';

/**
 * Every use of the VBScript name at the caret in this page, as a .vb or .js
 * file highlights them. The page and its includes are bound as for hover, but
 * no other page is read: this runs on every caret move.
 */
export class AspDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
    provideDocumentHighlights(document: vscode.TextDocument, position: vscode.Position): vscode.DocumentHighlight[] | undefined {
        const found = wordAt(document, position);
        if ('reason' in found) { return undefined; }
        const resolved = resolveAt(editorWorkspace(document), document.uri.fsPath, document.offsetAt(found.range.start), false);
        if (!resolved) { return undefined; }
        return sitesIn(resolved.bound, resolved.target)
            .filter(site => pathKey(site.file) === pathKey(document.uri.fsPath))
            .map(site => new vscode.DocumentHighlight(
                new vscode.Range(document.positionAt(site.start), document.positionAt(site.end)),
                site.declaration ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read,
            ));
    }
}
