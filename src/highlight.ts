import { ExtensionContext, Range, TextEditorDecorationType, window, workspace } from "vscode";
import { getAspRegions } from "./region";

export function addRegionHighlights(context: ExtensionContext) {
	// Declare all variables at the top of the function
	let timeout: NodeJS.Timeout | null = null;
	let bracketDecorationType: TextEditorDecorationType;
	let codeBlockDecorationType: TextEditorDecorationType;
	let configurationDidChange = false;

	let activeEditor = window.activeTextEditor;
	if (activeEditor) {
		triggerUpdateDecorations();
	}

	window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		if (editor) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	workspace.onDidChangeConfiguration(() => {
		configurationDidChange = true;
		triggerUpdateDecorations();
	});

	workspace.onDidChangeTextDocument(event => {
		if (activeEditor && event.document === activeEditor.document) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	function triggerUpdateDecorations() {
		if (timeout) {
			clearTimeout(timeout);
		}
		timeout = setTimeout(updateDecorations, 200);
	}

	function setDecorationTypes() {
		const aspConfig = workspace.getConfiguration("aspLanguageSupport");

		const bracketLightColor = aspConfig.get<string>("bracketLightColor");
		const bracketDarkColor = aspConfig.get<string>("bracketDarkColor");
		const codeBlockLightColor = aspConfig.get<string>("codeBlockLightColor");
		const codeBlockDarkColor = aspConfig.get<string>("codeBlockDarkColor");

		bracketDecorationType = window.createTextEditorDecorationType({
			light: {
				backgroundColor: bracketLightColor
			},
			dark: {
				backgroundColor: bracketDarkColor
			}
		});

		codeBlockDecorationType = window.createTextEditorDecorationType({
			light: {
				backgroundColor: codeBlockLightColor
			},
			dark: {
				backgroundColor: codeBlockDarkColor
			}
		});
	}

	function updateDecorations() {
		if (!activeEditor) {
			return;
		}

		const aspConfig = workspace.getConfiguration("aspLanguageSupport");
		const highlightAspRegions: boolean = aspConfig.get<boolean>("highlightAspRegions", true);

		// Create our decoration types
		if(!bracketDecorationType || !codeBlockDecorationType) {
			setDecorationTypes();
		}

		if(configurationDidChange || !highlightAspRegions) {
			if (bracketDecorationType) {
				bracketDecorationType.dispose();
			}
			if (codeBlockDecorationType) {
				codeBlockDecorationType.dispose();
			}
			setDecorationTypes();

			configurationDidChange = false;
		}

		if (!highlightAspRegions) {
			return;
		}

		const regions = getAspRegions(activeEditor.document);

		if (!regions || regions.length === 0) {
			return;
		}

		const blocks: Range[] = [];
		const brackets: Range[] = [];

		for(const region of regions) {
			brackets.push(region.openingBracket);
			blocks.push(region.codeBlock);
			brackets.push(region.closingBracket);
		}

		activeEditor.setDecorations(bracketDecorationType, brackets);
		activeEditor.setDecorations(codeBlockDecorationType, blocks);
	}
}