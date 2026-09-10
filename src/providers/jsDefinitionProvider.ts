/**
 * jsDefinitionProvider.ts  (providers/)
 *
 * Go to Definition (F12) for symbols inside <script> blocks.
 *
 * A plain .html file gives this for free because VS Code hands its <script>
 * content to the TypeScript server. A Classic ASP page has to ask for it, since
 * the JS lives in a virtual file this extension assembles.
 *
 * Only spans inside the document are offered. The language service will happily
 * point at lib.dom.d.ts or at the generated preamble, and neither is somewhere a
 * reader can be sent — see toDocumentSpan.
 */

import * as vscode from 'vscode';
import { buildVirtualJsContent, getJsLanguageService, toDocumentSpan } from '../utils/jsUtils';
import { getZone } from '../utils/zoneUtils';

export class JsDefinitionProvider implements vscode.DefinitionProvider {

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.Location[]> {

        const fullText = document.getText();
        const offset   = document.offsetAt(position);

        if (getZone(fullText, offset) !== 'js') { return undefined; }

        const { virtualContent, isInScript, preambleLength } =
            buildVirtualJsContent(fullText, offset);
        if (!isInScript || token.isCancellationRequested) { return undefined; }

        const svc = getJsLanguageService();
        svc.updateContent(virtualContent);

        const definitions = svc.getDefinitions(offset + preambleLength);
        if (!definitions.length || token.isCancellationRequested) { return undefined; }

        const locations: vscode.Location[] = [];
        for (const def of definitions) {
            const span = toDocumentSpan(def.fileName, def.textSpan, preambleLength);
            if (!span) { continue; }
            locations.push(new vscode.Location(
                document.uri,
                new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
            ));
        }

        return locations.length ? locations : undefined;
    }
}
