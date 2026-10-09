/**
 * jsDefinitionProvider.ts  (js/)
 *
 * Go to Definition (F12) for symbols inside <script> blocks.
 *
 * A plain .html file gives this for free because VS Code hands its <script>
 * content to the TypeScript server. A Classic ASP page has to ask for it, since
 * the JS lives in a virtual file this extension assembles.
 *
 * Only spans inside the document are offered. The language service will happily
 * point at lib.dom.d.ts or at the generated preamble, and neither is somewhere a
 * reader can be sent — see jsRange.
 */

import * as vscode from 'vscode';
import { jsQueryAt, jsRange } from './jsDocument';

export class JsDefinitionProvider implements vscode.DefinitionProvider {

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token:    vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.Location[]> {

        const query = jsQueryAt(document, position);
        if (!query || token.isCancellationRequested) { return undefined; }
        const { svc, virtualOffset, preambleLength } = query;

        const definitions = svc.getDefinitions(virtualOffset);
        if (!definitions.length || token.isCancellationRequested) { return undefined; }

        const locations: vscode.Location[] = [];
        for (const def of definitions) {
            const range = jsRange(document, preambleLength, def.fileName, def.textSpan);
            if (range) { locations.push(new vscode.Location(document.uri, range)); }
        }

        return locations.length ? locations : undefined;
    }
}
