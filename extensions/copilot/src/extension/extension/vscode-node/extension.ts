import { ExtensionContext } from 'vscode';

export function activate(_context: ExtensionContext, _forceActivation?: boolean) {
	console.log('[Copilot] Disabled in Magis IDE — Magis Agent is the sole AI provider.');
}

export function deactivate() {}
