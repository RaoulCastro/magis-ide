/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Magis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';

export interface MagisHttpClientConfig {
	baseUrl: string;
	authToken?: string;
	/** Request timeout in milliseconds (default: 120_000). */
	timeout?: number;
}

export interface MagisSessionResponse {
	id: string;
	user_id: string;
	workspace_path?: string;
	title?: string;
	created_at: string;
}

export interface MagisChatResponse {
	id: string;
	session_id: string;
	parent_chat_id?: string;
	model: string;
	created_at: string;
}

export interface MagisModelResponse {
	id: string;
	name?: string;
	description?: string;
	maxTokens?: number;
	contextWindow?: number;
}

export interface MagisSseEvent {
	event: string;
	data: any;
}

/**
 * Low-level HTTP client for the Magis Agent Service REST API.
 *
 * Uses Node's built-in `http`/`https` modules so it works in the agent host
 * without any external dependencies. All methods are async and throw on
 * non-2xx responses.
 */
export class MagisHttpClient {
	private _baseUrl: string;
	private _authToken?: string;
	private readonly _timeout: number;

	constructor(config: MagisHttpClientConfig) {
		this._baseUrl = config.baseUrl.replace(/\/$/, '');
		this._authToken = config.authToken;
		this._timeout = config.timeout ?? 120_000;
	}

	setAuthToken(token: string | undefined): void {
		this._authToken = token;
	}

	setBaseUrl(url: string): void {
		this._baseUrl = url.replace(/\/$/, '');
	}

	// ---- Internal helpers ----

	private _getHeaders(extra: Record<string, string> = {}): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			...extra,
		};
		if (this._authToken) {
			headers['Authorization'] = `Bearer ${this._authToken}`;
		}
		return headers;
	}

	private _request<T>(
		path: string,
		options: Omit<http.RequestOptions, 'hostname' | 'port' | 'path'> = {},
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		const urlStr = `${this._baseUrl}${path}`;
		const urlObj = new URL(urlStr);
		const isHttps = urlObj.protocol === 'https:';
		const lib: typeof https = isHttps ? https : http as any;

		const headers = this._getHeaders(options.headers as Record<string, string> ?? {});
		const reqOptions: http.RequestOptions = {
			...options,
			hostname: urlObj.hostname,
			port: urlObj.port || (isHttps ? 443 : 80),
			path: urlObj.pathname + urlObj.search,
			method: options.method ?? 'GET',
			headers,
			timeout: this._timeout,
		};

		return new Promise<T>((resolve, reject) => {
			const req = lib.request(reqOptions, (res) => {
				let buf = '';
				res.on('data', (chunk: Buffer) => { buf += chunk.toString('utf-8'); });
				res.on('end', () => {
					const status = res.statusCode ?? 0;
					if (status >= 200 && status < 300) {
						try {
							resolve(buf ? JSON.parse(buf) : ({} as T));
						} catch {
							reject(new Error(`[MagisHttpClient] Invalid JSON from ${path}: ${buf.slice(0, 200)}`));
						}
					} else if (status === 204) {
						resolve({} as T);
					} else {
						reject(new Error(`[MagisHttpClient] HTTP ${status} from ${path}: ${buf.slice(0, 200)}`));
					}
				});
			});

			req.on('error', reject);
			req.on('timeout', () => {
				req.destroy(new Error(`[MagisHttpClient] Timeout from ${path}`));
			});

			if (signal) {
				signal.addEventListener('abort', () => {
					req.destroy(new Error('Request aborted'));
					reject(new Error('Request aborted'));
				});
			}

			if (body !== undefined) {
				req.write(JSON.stringify(body));
			}
			req.end();
		});
	}

	// ---- Sessions ----

	createSession(workspacePath?: string, title?: string): Promise<MagisSessionResponse> {
		return this._request<MagisSessionResponse>(
			'/sessions',
			{ method: 'POST' },
			{ workspace_path: workspacePath, title },
		);
	}

	listSessions(): Promise<MagisSessionResponse[]> {
		return this._request<MagisSessionResponse[]>('/sessions', { method: 'GET' });
	}

	getSession(sessionId: string): Promise<MagisSessionResponse | undefined> {
		return this._request<MagisSessionResponse>(`/sessions/${sessionId}`, { method: 'GET' })
			.catch(() => undefined);
	}

	deleteSession(sessionId: string): Promise<void> {
		return this._request<void>(`/sessions/${sessionId}`, { method: 'DELETE' });
	}

	// ---- Chats ----

	createChat(sessionId: string, model?: string): Promise<MagisChatResponse> {
		return this._request<MagisChatResponse>(
			`/sessions/${sessionId}/chats`,
			{ method: 'POST' },
			{ model },
		);
	}

	forkChat(chatId: string, sourceTurnId?: string): Promise<MagisChatResponse> {
		return this._request<MagisChatResponse>(
			`/chats/${chatId}/fork`,
			{ method: 'POST' },
			{ source_turn_id: sourceTurnId },
		);
	}

	deleteChat(chatId: string): Promise<void> {
		return this._request<void>(`/chats/${chatId}`, { method: 'DELETE' });
	}

	changeModel(chatId: string, model: string): Promise<void> {
		return this._request<void>(`/chats/${chatId}/model`, { method: 'POST' }, { model });
	}

	abortChat(chatId: string): Promise<void> {
		return this._request<void>(`/chats/${chatId}/abort`, { method: 'POST' });
	}

	// ---- Messages & turns ----

	/**
	 * Stream a user message to the backend and call `onEvent` for each SSE event.
	 *
	 * The returned promise resolves when the stream ends normally or rejects on
	 * network error. If `signal` is aborted, the socket is destroyed and the
	 * promise rejects with `'Stream aborted'`.
	 */
	streamMessage(
		chatId: string,
		message: string,
		model: string | undefined,
		onEvent: (event: MagisSseEvent) => void,
		signal?: AbortSignal,
	): Promise<void> {
		const urlStr = `${this._baseUrl}/chats/${chatId}/messages`;
		const urlObj = new URL(urlStr);
		const isHttps = urlObj.protocol === 'https:';
		const lib: typeof https = isHttps ? https : http as any;

		const headers = this._getHeaders({ Accept: 'text/event-stream' });

		return new Promise<void>((resolve, reject) => {
			const req = lib.request({
				hostname: urlObj.hostname,
				port: urlObj.port || (isHttps ? 443 : 80),
				path: urlObj.pathname + urlObj.search,
				method: 'POST',
				headers,
				timeout: this._timeout,
			}, (res) => {
				if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
					let errBody = '';
					res.on('data', (c: Buffer) => { errBody += c; });
					res.on('end', () => reject(new Error(`[MagisHttpClient] HTTP ${res.statusCode} from streamMessage: ${errBody.slice(0, 200)}`)));
					return;
				}

				let buffer = '';
				let currentEvent = 'message';

				res.on('data', (chunk: Buffer) => {
					buffer += chunk.toString('utf-8');
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						const trimmed = line.trimEnd();
						if (!trimmed) {
							// Blank line = end of event — already dispatched above.
							continue;
						}
						if (trimmed.startsWith('event:')) {
							currentEvent = trimmed.slice(6).trim();
						} else if (trimmed.startsWith('data:')) {
							const dataStr = trimmed.slice(5).trim();
							let parsed: unknown;
							try {
								parsed = JSON.parse(dataStr);
							} catch {
								parsed = dataStr;
							}
							onEvent({ event: currentEvent, data: parsed });
							// SSE: reset event to default after a data line.
							currentEvent = 'message';
						}
					}
				});

				res.on('end', resolve);
				res.on('error', reject);
			});

			req.on('error', reject);

			if (signal) {
				signal.addEventListener('abort', () => {
					req.destroy();
					reject(new Error('Stream aborted'));
				});
			}

			req.write(JSON.stringify({ content: message, model }));
			req.end();
		});
	}

	getTurns(chatId: string): Promise<any[]> {
		return this._request<any[]>(`/chats/${chatId}/turns`, { method: 'GET' });
	}

	// ---- Permissions ----

	respondToPermission(requestId: string, approved: boolean): Promise<void> {
		return this._request<void>(`/permissions/${requestId}`, { method: 'POST' }, { approved });
	}

	// ---- Models ----

	getModels(): Promise<MagisModelResponse[]> {
		return this._request<MagisModelResponse[]>('/models', { method: 'GET' });
	}
}
