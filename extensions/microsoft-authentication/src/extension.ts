import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext) {
	console.log('[Microsoft Auth] Disabled in Magis IDE — Magis Authentication is the sole auth provider.');
}

export function deactivate() {}
