import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isExternalPath, FILE_LINK_ATTRIBUTES } from './includeProvider';

// ─────────────────────────────────────────────────────────────────────────────
// IncludeDocumentLinkProvider
// Underlines #include file="..." paths persistently with a "Follow link" tooltip.
// virtual="..." support can be added later once the server root is defined.
// ─────────────────────────────────────────────────────────────────────────────

export class IncludeDocumentLinkProvider implements vscode.DocumentLinkProvider {

    provideDocumentLinks(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentLink[]> {

        const links:  vscode.DocumentLink[] = [];
        const docDir  = path.dirname(document.uri.fsPath);
        const pattern = /<!--\s*#include\s+file\s*=\s*["']([^"']+)["']\s*-->/gi;

        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            pattern.lastIndex = 0;

            let match: RegExpExecArray | null;
            while ((match = pattern.exec(lineText)) !== null) {
                const includePath = match[1];
                const fullPath    = path.resolve(docDir, includePath);
                if (!fs.existsSync(fullPath)) continue;

                // Underline only the path string, not the whole directive
                const pathStart = lineText.indexOf(includePath, match.index);
                const link      = new vscode.DocumentLink(
                    new vscode.Range(
                        new vscode.Position(i, pathStart),
                        new vscode.Position(i, pathStart + includePath.length)
                    ),
                    vscode.Uri.file(fullPath)
                );
                link.tooltip = 'Follow link';
                links.push(link);
            }
        }

        return links;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HtmlAttributeLinkProvider
// Underlines local file paths in href, src, action, and data-src attributes.
// External URLs, anchors, mailto:, etc. are intentionally skipped.
// ─────────────────────────────────────────────────────────────────────────────

export class HtmlAttributeLinkProvider implements vscode.DocumentLinkProvider {

    provideDocumentLinks(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentLink[]> {

        const links:  vscode.DocumentLink[] = [];
        const docDir  = path.dirname(document.uri.fsPath);
        const pattern = new RegExp(
            `\\b(${FILE_LINK_ATTRIBUTES.join('|')})\\s*=\\s*["']([^"']+)["']`,
            'gi'
        );

        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            pattern.lastIndex = 0;

            let match: RegExpExecArray | null;
            while ((match = pattern.exec(lineText)) !== null) {
                const attrValue = match[2];
                if (isExternalPath(attrValue)) continue;

                const fullPath = path.resolve(docDir, attrValue);
                if (!fs.existsSync(fullPath)) continue;

                // Underline only the attribute value, not the attribute name
                const valueOffset = match[0].indexOf(attrValue);
                const valueStart  = match.index + valueOffset;
                const link        = new vscode.DocumentLink(
                    new vscode.Range(
                        new vscode.Position(i, valueStart),
                        new vscode.Position(i, valueStart + attrValue.length)
                    ),
                    vscode.Uri.file(fullPath)
                );
                link.tooltip = 'Follow link';
                links.push(link);
            }
        }

        return links;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HtmlAttributePathCompletionProvider
// Suggests files and folders inside href, src, action, and data-src attribute
// values — same directory-scanning behaviour as IncludePathCompletionProvider.
// Skips values that are already external URLs.
// ─────────────────────────────────────────────────────────────────────────────

// Pattern matching the opening of any file-link attribute up to the cursor,
// capturing the typed path so far. Used to decide when to activate.
const ATTR_TRIGGER_PATTERN = new RegExp(
    `\\b(${FILE_LINK_ATTRIBUTES.join('|')})\\s*=\\s*["']([^"']*)$`,
    'i'
);

export class HtmlAttributePathCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        const attrMatch = textBefore.match(ATTR_TRIGGER_PATTERN);

        // If no attribute match, return false so we don't interfere with other providers.
        if (!attrMatch) return new vscode.CompletionList([], false);

        const typedSoFar = attrMatch[2];

        // Don't suggest for external URLs, but return isIncomplete:true so the
        // session stays alive — VS Code's built-in HTML provider would otherwise
        // close the suggestion session with isIncomplete:false, preventing our
        // provider from firing again when the user continues typing.
        if (isExternalPath(typedSoFar)) return new vscode.CompletionList([], true);

        const docDir = path.dirname(document.uri.fsPath);

        // Split typed path into directory prefix and the current segment.
        // Normalise to forward-slashes first so path splitting works on Windows.
        const normalised   = typedSoFar.replace(/\\/g, '/');
        const lastSlash    = normalised.lastIndexOf('/');
        const typedDirPart = lastSlash >= 0 ? normalised.slice(0, lastSlash + 1) : '';
        const typedSegment = lastSlash >= 0 ? normalised.slice(lastSlash + 1)    : normalised;
        const searchDir    = path.resolve(docDir, typedDirPart.replace(/\//g, path.sep));

        // Replace only the current segment so the typed directory prefix is never duplicated
        const replaceStart = new vscode.Position(position.line, position.character - typedSegment.length);
        const replaceRange = new vscode.Range(replaceStart, position);

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(searchDir, { withFileTypes: true });
        } catch {
            return new vscode.CompletionList([], true);
        }

        const items: vscode.CompletionItem[] = [];

        for (const entry of entries.filter(e => !e.name.startsWith('.'))) {
            const isDir  = entry.isDirectory();
            const isFile = entry.isFile();
            if (!isDir && !isFile) continue;

            const item = new vscode.CompletionItem(
                entry.name,
                isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
            );
            item.insertText = isDir ? entry.name + '/' : entry.name;
            item.filterText = entry.name;
            item.range      = replaceRange;
            item.detail     = isDir ? 'Directory' : 'File';
            item.sortText   = (isDir ? '0_' : '1_') + entry.name.toLowerCase();

            // Re-trigger after folder selection so the next level appears immediately
            if (isDir) item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };

            // Re-trigger after folder selection so the next level appears immediately
            if (isDir) item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };

            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }
}