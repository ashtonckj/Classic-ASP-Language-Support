import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveHtmlAttributeFilePath, isExternalPath, FILE_LINK_ATTRIBUTES } from './includeProvider';

// ─────────────────────────────────────────────────────────────────────────────
// IncludeDocumentLinkProvider
// Underlines #include file="..." paths persistently and shows the native
// "Follow link (Ctrl+Click)" tooltip. Only file="..." is supported here;
// virtual="..." support can be added later once the server root is defined.
// ─────────────────────────────────────────────────────────────────────────────

export class IncludeDocumentLinkProvider implements vscode.DocumentLinkProvider {

    provideDocumentLinks(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentLink[]> {

        const links:   vscode.DocumentLink[] = [];
        const docDir   = path.dirname(document.uri.fsPath);
        const pattern  = /<!--\s*#include\s+file\s*=\s*["']([^"']+)["']\s*-->/gi;

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
                link.tooltip = 'Follow link (Ctrl+Click)';
                links.push(link);
            }
        }

        return links;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HtmlAttributeLinkProvider
// Underlines local file paths in href, src, action, and data-src attributes
// with the same persistent underline and "Follow link (Ctrl+Click)" tooltip.
// External URLs, anchors, mailto:, etc. are intentionally skipped.
// ─────────────────────────────────────────────────────────────────────────────

export class HtmlAttributeLinkProvider implements vscode.DocumentLinkProvider {

    provideDocumentLinks(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentLink[]> {

        const links  : vscode.DocumentLink[] = [];
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
                link.tooltip = 'Follow link (Ctrl+Click)';
                links.push(link);
            }
        }

        return links;
    }
}