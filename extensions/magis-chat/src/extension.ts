/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Magis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentConfig {
	baseUrl: string;
	model: string;
}

interface StreamChunk {
	kind: 'markdown' | 'tool.start' | 'tool.end' | 'error' | 'turn.end';
	text?: string;
	tool?: string;
	input?: unknown;
	output?: string;
	status?: string;
	message?: string;
}

// ─── HTTP streaming helper ────────────────────────────────────────────────────

function streamRequest(
	url: string,
	body: string,
	authToken: string | undefined,
	onChunk: (chunk: StreamChunk) => void,
	signal: AbortSignal
): Promise<void> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const lib = parsed.protocol === 'https:' ? https : http;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body).toString(),
			'Accept': 'text/event-stream',
		};
		if (authToken) {
			headers['Authorization'] = `Bearer ${authToken}`;
		}

		const req = lib.request(
			{
				hostname: parsed.hostname,
				port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
				path: parsed.pathname + parsed.search,
				method: 'POST',
				headers,
			},
			(res) => {
				if (res.statusCode && res.statusCode >= 400) {
					let errBody = '';
					res.on('data', (d: Buffer) => (errBody += d.toString()));
					res.on('end', () => {
						try {
							const j = JSON.parse(errBody);
							reject(new Error(j?.detail?.message || j?.detail || errBody));
						} catch {
							reject(new Error(`HTTP ${res.statusCode}: ${errBody}`));
						}
					});
					return;
				}

				let buffer = '';
				res.on('data', (chunk: Buffer) => {
					buffer += chunk.toString();
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';
					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const raw = line.slice(6).trim();
							if (!raw || raw === '[DONE]') { continue; }
							try {
								onChunk(JSON.parse(raw) as StreamChunk);
							} catch { /* ignore malformed */ }
						}
					}
				});
				res.on('end', resolve);
				res.on('error', reject);
			}
		);

		req.on('error', reject);
		signal.addEventListener('abort', () => {
			req.destroy();
			reject(new Error('Cancelled'));
		});
		req.write(body);
		req.end();
	});
}

// ─── Agent API client ─────────────────────────────────────────────────────────

class MagisAgentClient {
	private _authToken: string | undefined;
	private _sessionId: string | undefined;
	private _chatId: string | undefined;

	constructor(private readonly cfg: AgentConfig) {}

	async refreshAuthToken(): Promise<void> {
		try {
			const session = await vscode.authentication.getSession('magis', [], { createIfNone: false });
			this._authToken = session?.accessToken;
		} catch {
			this._authToken = undefined;
		}
	}

	get authToken(): string | undefined { return this._authToken; }

	private get _headers(): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this._authToken) { h['Authorization'] = `Bearer ${this._authToken}`; }
		return h;
	}

	private async _fetch(path: string, init: RequestInit = {}): Promise<any> {
		const res = await fetch(`${this.cfg.baseUrl}${path}`, {
			...init,
			headers: { ...this._headers, ...(init.headers as Record<string, string> || {}) },
		});
		const json = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error((json as any)?.detail?.message || (json as any)?.detail || `HTTP ${res.status}`);
		}
		return json;
	}

	/** Ensure we have a session; create one if not. */
	private async _ensureSession(workspacePath: string): Promise<string> {
		if (this._sessionId) { return this._sessionId; }
		const data = await this._fetch('/sessions', {
			method: 'POST',
			body: JSON.stringify({ title: 'Magis IDE Session', workspace_path: workspacePath }),
		});
		this._sessionId = data.id;
		return data.id;
	}

	/** Ensure we have a chat within the session; create one if not. */
	private async _ensureChat(sessionId: string): Promise<string> {
		if (this._chatId) { return this._chatId; }
		const data = await this._fetch(`/sessions/${sessionId}/chats`, {
			method: 'POST',
			body: JSON.stringify({ model: this.cfg.model }),
		});
		this._chatId = data.id;
		return data.id;
	}

	/** Reset the current chat so next message starts a fresh conversation. */
	newChat(): void {
		this._chatId = undefined;
	}

	/** Send a message and stream chunks back via onChunk. */
	async sendMessage(
		userMessage: string,
		context: vscode.ChatContext,
		onChunk: (chunk: StreamChunk) => void,
		signal: AbortSignal
	): Promise<void> {
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/tmp/magis-workspace';
		const sessionId = await this._ensureSession(workspacePath);
		const chatId = await this._ensureChat(sessionId);

		// Build context from previous chat history (last 3 exchanges)
		const historyMessages = context.history
			.slice(-6)
			.filter(h => h instanceof vscode.ChatRequestTurn || h instanceof vscode.ChatResponseTurn)
			.map(h => {
				if (h instanceof vscode.ChatRequestTurn) {
					return { role: 'user', content: h.prompt };
				}
				// ChatResponseTurn: extract markdown text
				const text = h.response
					.filter(r => r instanceof vscode.ChatResponseMarkdownPart)
					.map(r => (r as vscode.ChatResponseMarkdownPart).value.value)
					.join('');
				return { role: 'assistant', content: text };
			})
			.filter(m => m.content.trim());

		const body = JSON.stringify({
			content: userMessage,
			history: historyMessages,
		});

		const url = `${this.cfg.baseUrl}/chats/${chatId}/messages`;
		await streamRequest(url, body, this._authToken, onChunk, signal);
	}

	dispose(): void {}
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	console.log('[MagisChat] Extension activating...');

	const cfg = vscode.workspace.getConfiguration('magis');
	const agentCfg: AgentConfig = {
		baseUrl: cfg.get<string>('baseUrl', 'http://localhost:8787'),
		model: cfg.get<string>('model', 'qwen-code'),
	};

	const client = new MagisAgentClient(agentCfg);

	// Prime the auth token at startup (non-blocking)
	client.refreshAuthToken().catch(() => {});

	// ── Command: New Chat ──
	const newChatCmd = vscode.commands.registerCommand('magis.newChat', () => {
		client.newChat();
		vscode.window.showInformationMessage('Magis: Nouvelle conversation démarrée.');
	});

	// ── Command: Sign In ──
	const signInCmd = vscode.commands.registerCommand('magis.signIn', async () => {
		try {
			await vscode.authentication.getSession('magis', ['openid', 'profile', 'email'], { createIfNone: true });
			await client.refreshAuthToken();
			vscode.window.showInformationMessage('✓ Connecté à Magis.');
		} catch (err) {
			vscode.window.showErrorMessage(`Erreur de connexion Magis: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// ── Chat participant handler ──
	const handler: vscode.ChatRequestHandler = async (
		request: vscode.ChatRequest,
		chatContext: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	) => {
		// Refresh token before every request (handles expiry)
		await client.refreshAuthToken();

		// Handle /new command
		if (request.command === 'new') {
			client.newChat();
			stream.markdown('✓ Nouvelle conversation démarrée. Comment puis-je vous aider ?');
			return;
		}

		// Handle /help command
		if (request.command === 'help') {
			stream.markdown([
				'## Magis AI Agent\n',
				'**Commandes disponibles:**\n',
				'- `/new` — Démarrer une nouvelle conversation\n',
				'- `/help` — Afficher cette aide\n\n',
				'**Capacités:**\n',
				'- 💬 Chat IA avec Qwen (vLLM)\n',
				'- 📁 Lecture/écriture de fichiers\n',
				'- ⚙️ Exécution de commandes shell\n',
				'- 🔍 Recherche dans le code\n',
			].join(''));
			return;
		}

		const prompt = request.prompt.trim();
		if (!prompt) {
			stream.markdown('_Veuillez entrer un message._');
			return;
		}

		// Abort signal from VS Code cancellation
		const abortController = new AbortController();
		token.onCancellationRequested(() => abortController.abort());

		stream.progress('Magis réfléchit...');

		let hasContent = false;
		let toolName: string | undefined;

		try {
			await client.sendMessage(
				prompt,
				chatContext,
				(chunk) => {
					switch (chunk.kind) {
						case 'markdown':
							if (chunk.text) {
								stream.markdown(chunk.text);
								hasContent = true;
							}
							break;

						case 'tool.start':
							toolName = chunk.tool;
							if (toolName) {
								stream.progress(`🔧 ${toolName}…`);
							}
							break;

						case 'tool.end':
							// Tool completed — progress clears automatically
							toolName = undefined;
							break;

						case 'error':
							stream.markdown(`\n\n> ⚠️ **Erreur:** ${chunk.message || 'Erreur inconnue'}`);
							break;

						case 'turn.end':
							// Done
							break;
					}
				},
				abortController.signal
			);

			if (!hasContent) {
				stream.markdown('_Aucune réponse reçue de l\'agent._');
			}
		} catch (err) {
			if ((err as Error).message === 'Cancelled') {
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);

			// If 401, prompt to sign in
			if (msg.includes('401') || msg.toLowerCase().includes('invalid_token') || msg.toLowerCase().includes('unauthorized')) {
				stream.markdown(
					'> 🔐 **Authentification requise.**\n\n' +
					'Cliquez sur **Se connecter** dans la barre d\'état ou exécutez la commande `Magis: Se connecter`.'
				);
				const action = await vscode.window.showWarningMessage(
					'Magis: Authentification requise.',
					'Se connecter'
				);
				if (action === 'Se connecter') {
					await vscode.commands.executeCommand('magis.signIn');
				}
			} else {
				stream.markdown(`> ⚠️ **Erreur:** ${msg}`);
				console.error('[MagisChat] Error:', err);
			}
		}
	};

	// Register the @magis chat participant
	const participant = vscode.chat.createChatParticipant('magis', handler);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'magis.png');

	// Update config dynamically
	const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('magis')) {
			const newCfg = vscode.workspace.getConfiguration('magis');
			(agentCfg as any).baseUrl = newCfg.get<string>('baseUrl', 'http://localhost:8787');
			(agentCfg as any).model = newCfg.get<string>('model', 'qwen-code');
		}
	});

	// Re-acquire token whenever the auth session changes
	const sessionWatcher = vscode.authentication.onDidChangeSessions((e) => {
		if (e.provider.id === 'magis') {
			client.refreshAuthToken().catch(() => {});
		}
	});

	context.subscriptions.push(
		participant,
		newChatCmd,
		signInCmd,
		configWatcher,
		sessionWatcher,
		{ dispose: () => client.dispose() }
	);

	console.log('[MagisChat] Extension activated. Agent URL:', agentCfg.baseUrl);
}

export function deactivate() {
	console.log('[MagisChat] Extension deactivated.');
}
