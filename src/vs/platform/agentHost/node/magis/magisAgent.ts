/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Magis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type {
	IAgent,
	IAgentChats,
	IAgentDescriptor,
	IAgentCreateSessionConfig,
	IAgentCreateSessionResult,
	IAgentCreateChatOptions,
	IAgentCreateChatResult,
	IAgentCreateChatForkSource,
	IAgentMaterializeSessionEvent,
	IAgentSpawnChatEvent,
	IAgentChatDataChange,
	IAgentSessionMetadata,
	AgentProvider,
	AgentSignal,
	IAgentSessionAdoptionResult,
	IAgentResolveSessionConfigParams,
	IAgentSessionConfigCompletionsParams,
	IAgentModelInfo,
	IActiveClient,
} from '../../common/agentService.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/channels-root/commands.js';
import type { ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import type { ModelSelection, AgentSelection, MessageAttachment, Turn, ToolCallResult } from '../../common/state/sessionState.js';
import type { AgentHostClientType } from '../../common/agentHostClientInfo.js';
import { ActionType } from '../../common/state/protocol/common/actions.js';
import { MagisHttpClient, MagisSseEvent, MagisSessionResponse } from './magisHttpClient.js';
import type { IRequestService } from '../../../request/common/request.js';
import type { ILogService } from '../../../log/common/log.js';

export interface MagisAgentConfig {
	baseUrl: string;
	authToken?: string;
	logService?: ILogService;
}

/** Magis agent provider identifier — must not clash with 'copilot' / 'claude' / 'codex'. */
const MAGIS_PROVIDER_ID = 'magis' as AgentProvider;

/** Protected resource registered in the Magis authentication service. */
const MAGIS_PROTECTED_RESOURCE: ProtectedResourceMetadata = {
	resource: 'magis-agent-service',
	resource_name: 'Magis Agent Service',
	authorization_servers: ['http://10.30.0.11:8001'],
	scopes_supported: ['chat', 'tools'],
	required: true,
};

interface SessionRecord {
	sessionId: string;
	chatIds: Set<string>;
	remoteTitle?: string;
}

/**
 * Agent provider implementation that talks to the `magis-agent-service` HTTP API.
 * Connects Magis IDE workbench chat to LangGraph + vLLM microservices.
 */
export class MagisAgent extends Disposable implements IAgent {
	readonly id = MAGIS_PROVIDER_ID;

	// ---- Events required by IAgent ----

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	private readonly _onDidMaterializeSession = this._register(new Emitter<IAgentMaterializeSessionEvent>());
	readonly onDidMaterializeSession: Event<IAgentMaterializeSessionEvent> = this._onDidMaterializeSession.event;

	private readonly _onDidChangeSessionList = this._register(new Emitter<void>());
	readonly onDidChangeSessionList: Event<void> = this._onDidChangeSessionList.event;

	private readonly _onDidSpawnChat = this._register(new Emitter<IAgentSpawnChatEvent>());
	readonly onDidSpawnChat: Event<IAgentSpawnChatEvent> = this._onDidSpawnChat.event;

	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData: Event<IAgentChatDataChange> = this._onDidChangeChatData.event;

	private readonly _onDidEndChat = this._register(new Emitter<URI>());

	// ---- Observable Models ----

	private readonly _modelsObservable = observableValue<readonly IAgentModelInfo[]>('magisModels', []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._modelsObservable;

	// ---- Internal State ----

	private readonly httpClient: MagisHttpClient;
	private readonly _sessions = new Map<string, SessionRecord>();
	private readonly _activeAbortControllers = new Map<string, AbortController>();
	private readonly _activeClients = new Map<string, IActiveClient>();
	private readonly _logService?: ILogService;
	private _isRefreshingModels = false;

	constructor(
		config: MagisAgentConfig,
		requestService: IRequestService,
		logService?: ILogService
	) {
		super();
		this._logService = logService ?? config.logService;
		this.httpClient = new MagisHttpClient({
			baseUrl: config.baseUrl,
			authToken: config.authToken,
		});
		this.refreshModels().catch(err => {
			this._logService?.warn('[MagisAgent] Initial model refresh failed:', String(err));
		});
	}

	setAuthToken(token: string | undefined): void {
		this.httpClient.setAuthToken(token);
	}

	// ---- IAgent: descriptor & info ----

	getDescriptor(): IAgentDescriptor {
		return {
			provider: MAGIS_PROVIDER_ID,
			displayName: 'Magis AI Assistant',
			description: 'Magis Agent Service (LangGraph + vLLM Qwen 2.5/3)',
			capabilities: {},
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [MAGIS_PROTECTED_RESOURCE];
	}

	// ---- IAgent: models ----

	async refreshModels(): Promise<void> {
		if (this._isRefreshingModels) {
			return;
		}
		this._isRefreshingModels = true;
		try {
			const remoteModels = await this.httpClient.getModels();
			const modelInfos: IAgentModelInfo[] = remoteModels.map(m => ({
				provider: MAGIS_PROVIDER_ID,
				id: m.id,
				name: m.name || m.id,
				supportsVision: false,
			}));

			if (modelInfos.length === 0) {
				modelInfos.push({
					provider: MAGIS_PROVIDER_ID,
					id: 'qwen-code',
					name: 'Qwen 2.5 Code',
					supportsVision: false,
				});
			}

			this._modelsObservable.set(modelInfos, undefined);
		} catch (err) {
			this._logService?.warn('[MagisAgent] refreshModels failed:', String(err));
			if (this._modelsObservable.get().length === 0) {
				this._modelsObservable.set([
					{
						provider: MAGIS_PROVIDER_ID,
						id: 'qwen-code',
						name: 'Qwen 2.5 Code',
						supportsVision: false,
					},
				], undefined);
			}
		} finally {
			this._isRefreshingModels = false;
		}
	}

	// ---- IAgent: active clients ----

	getOrCreateActiveClient(session: URI, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = `${session.toString()}:${client.clientId}`;
		let active = this._activeClients.get(key);
		if (!active) {
			active = {
				clientId: client.clientId,
				displayName: client.displayName,
				tools: [],
				customizations: [],
			};
			this._activeClients.set(key, active);
		}
		return active;
	}

	removeActiveClient(session: URI, clientId: string): void {
		const key = `${session.toString()}:${clientId}`;
		this._activeClients.delete(key);
	}

	onClientToolCallComplete(_session: URI, _chat: URI, toolCallId: string, _result: ToolCallResult): void {
		this._logService?.info(`[MagisAgent] Client tool call completed: ${toolCallId}`);
	}

	async shutdown(): Promise<void> {
		for (const controller of this._activeAbortControllers.values()) {
			controller.abort();
		}
		this._activeAbortControllers.clear();
		this._sessions.clear();
		this._activeClients.clear();
	}

	// ---- IAgent: session listing ----

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		try {
			const remoteSessions = await this.httpClient.listSessions();
			return remoteSessions.map(s => this._remoteSessionToMetadata(s));
		} catch (err) {
			this._logService?.warn('[MagisAgent] listSessions failed:', String(err));
			return [];
		}
	}

	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const sessionId = this._extractSessionId(session);
		try {
			const remote = await this.httpClient.getSession(sessionId);
			return remote ? this._remoteSessionToMetadata(remote) : undefined;
		} catch {
			return undefined;
		}
	}

	// ---- IAgent: session lifecycle ----

	async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
		const primaryWd = config?.workingDirectories?.[0];
		const workspacePath = primaryWd?.fsPath;
		const remoteSession = await this.httpClient.createSession(workspacePath, undefined);
		const sessionUri = this._buildSessionUri(remoteSession.id);

		this._sessions.set(remoteSession.id, {
			sessionId: remoteSession.id,
			chatIds: new Set(),
			remoteTitle: remoteSession.title,
		});

		this._onDidMaterializeSession.fire({
			session: sessionUri,
			workingDirectories: config?.workingDirectories,
			project: primaryWd ? { uri: primaryWd, displayName: primaryWd.path.split('/').pop() || 'Workspace' } : undefined,
		});

		return {
			session: sessionUri,
			resolvedWorkingDirectory: primaryWd,
		};
	}

	async resolveSessionConfig(_params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return {
			schema: { type: 'object', properties: {} },
			values: {},
		};
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async disposeSession(session: URI): Promise<void> {
		const sessionId = this._extractSessionId(session);
		const sess = this._sessions.get(sessionId);
		if (!sess) {
			return;
		}
		for (const chatId of sess.chatIds) {
			const controller = this._activeAbortControllers.get(chatId);
			if (controller) {
				controller.abort();
				this._activeAbortControllers.delete(chatId);
			}
		}
		try {
			await this.httpClient.deleteSession(sessionId);
		} catch (err) {
			this._logService?.warn('[MagisAgent] deleteSession failed:', String(err));
		}
		this._sessions.delete(sessionId);
		this._onDidEndChat.fire(session);
	}

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const sessionId = this._extractSessionId(session);
		const sess = this._sessions.get(sessionId);
		if (!sess || sess.chatIds.size === 0) {
			return [];
		}
		const [firstChatId] = sess.chatIds;
		try {
			return await this.httpClient.getTurns(firstChatId);
		} catch {
			return [];
		}
	}

	async ensureSessionAdopted(_session: URI): Promise<IAgentSessionAdoptionResult> {
		return { adopted: false, eligible: false };
	}

	// ---- IAgent: permissions ----

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this.httpClient.respondToPermission(requestId, approved).catch(err => {
			this._logService?.error('[MagisAgent] respondToPermission failed:', String(err));
		});
	}

	respondToUserInputRequest(_requestId: string, _response: any, _answers?: any): void {
		this._logService?.info('[MagisAgent] respondToUserInputRequest — not yet implemented');
	}

	// ---- IAgent: auth ----

	async authenticate(resource: string, token: string): Promise<boolean> {
		if (token) {
			this.setAuthToken(token);
			this.refreshModels().catch(() => {/* swallow */ });
			return true;
		}
		return false;
	}

	// ---- IAgent: chats surface ----

	readonly chats: IAgentChats = {

		createChat: async (session: URI, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult> => {
			const sessionId = this._extractSessionId(session);
			const modelId = this._resolveModelId(options?.model);
			const remoteChat = await this.httpClient.createChat(sessionId, modelId);
			const chatUri = this._buildChatUri(sessionId, remoteChat.id);

			let sess = this._sessions.get(sessionId);
			if (!sess) {
				sess = { sessionId, chatIds: new Set() };
				this._sessions.set(sessionId, sess);
			}
			sess.chatIds.add(remoteChat.id);

			this._onDidChangeChatData.fire({
				chat: chatUri,
				providerData: JSON.stringify({ remoteChatId: remoteChat.id, model: remoteChat.model }),
			});

			return {
				providerData: JSON.stringify({ remoteChatId: remoteChat.id, model: remoteChat.model }),
			};
		},

		fork: async (sourceChat: URI, _forkSource: IAgentCreateChatForkSource): Promise<IAgentCreateChatResult> => {
			const sourceChatId = this._extractChatId(sourceChat);
			const remoteChat = await this.httpClient.forkChat(sourceChatId, _forkSource.turnId);
			const sessionId = remoteChat.session_id;
			const chatUri = this._buildChatUri(sessionId, remoteChat.id);

			let sess = this._sessions.get(sessionId);
			if (!sess) {
				sess = { sessionId, chatIds: new Set() };
				this._sessions.set(sessionId, sess);
			}
			sess.chatIds.add(remoteChat.id);

			this._onDidChangeChatData.fire({
				chat: chatUri,
				providerData: JSON.stringify({ remoteChatId: remoteChat.id, model: remoteChat.model }),
			});

			return {
				providerData: JSON.stringify({ remoteChatId: remoteChat.id, model: remoteChat.model }),
			};
		},

		disposeChat: async (chat: URI): Promise<void> => {
			const chatId = this._extractChatId(chat);
			const controller = this._activeAbortControllers.get(chatId);
			if (controller) {
				controller.abort();
				this._activeAbortControllers.delete(chatId);
			}
			try {
				await this.httpClient.deleteChat(chatId);
			} catch (err) {
				this._logService?.warn('[MagisAgent] deleteChat failed:', String(err));
			}
		},

		sendMessage: async (
			chat: URI,
			prompt: string,
			_workingDirectories: readonly URI[] | undefined,
			_attachments?: readonly MessageAttachment[],
			_turnId?: string,
			_senderClientId?: string,
			_clientType?: AgentHostClientType,
		): Promise<void> => {
			const chatId = this._extractChatId(chat);
			const sessionUri = this._buildSessionUriFromChat(chat);
			const modelId = 'qwen-code';

			const abortController = new AbortController();
			this._activeAbortControllers.set(chatId, abortController);

			try {
				await this.httpClient.streamMessage(
					chatId,
					prompt,
					modelId,
					(sseEvent: MagisSseEvent) => {
						this._handleSseEvent(sessionUri, chat, sseEvent);
					},
					abortController.signal,
				);
			} catch (err: any) {
				if (err?.message === 'Stream aborted') {
					return;
				}
				this._logService?.error('[MagisAgent] streamMessage error:', String(err));
				this._onDidSessionProgress.fire({
					kind: 'action',
					resource: sessionUri,
					action: {
						type: ActionType.ChatError,
						turnId: generateUuid(),
						message: String(err),
						metadata: {},
					} as any,
				});
			} finally {
				this._activeAbortControllers.delete(chatId);
			}
		},

		abort: async (chat: URI): Promise<void> => {
			const chatId = this._extractChatId(chat);
			const controller = this._activeAbortControllers.get(chatId);
			if (controller) {
				controller.abort();
				this._activeAbortControllers.delete(chatId);
			}
			try {
				await this.httpClient.abortChat(chatId);
			} catch (err) {
				this._logService?.warn('[MagisAgent] abortChat failed:', String(err));
			}
		},

		changeModel: async (chat: URI, model: ModelSelection): Promise<void> => {
			const chatId = this._extractChatId(chat);
			const modelId = this._resolveModelId(model) ?? 'qwen-code';
			await this.httpClient.changeModel(chatId, modelId);
		},

		changeAgent: async (_chat: URI, _agent: AgentSelection | undefined): Promise<void> => {
			// Sub-agent switching is handled dynamically on backend graphs.
		},

		getMessages: async (chat: URI): Promise<readonly Turn[]> => {
			const chatId = this._extractChatId(chat);
			try {
				return await this.httpClient.getTurns(chatId);
			} catch {
				return [];
			}
		},
	};

	// ---- SSE → AgentSignal mapping ----

	private _handleSseEvent(sessionUri: URI, chatUri: URI, sseEvent: MagisSseEvent): void {
		const { event, data } = sseEvent;

		if (event === 'turn.start') {
			this._onDidSessionProgress.fire({
				kind: 'action',
				resource: sessionUri,
				action: {
					type: ActionType.ChatTurnStarted,
					turnId: data.turn_id || generateUuid(),
				} as any,
			});
			return;
		}

		if (event === 'turn.end') {
			this._onDidSessionProgress.fire({
				kind: 'action',
				resource: sessionUri,
				action: {
					type: ActionType.ChatTurnComplete,
					turnId: data.turn_id || generateUuid(),
				} as any,
			});
			return;
		}

		if (event === 'part.delta') {
			if (data.type === 'markdown' && data.content) {
				this._onDidSessionProgress.fire({
					kind: 'action',
					resource: sessionUri,
					action: {
						type: ActionType.ChatDelta,
						turnId: data.turn_id || generateUuid(),
						delta: data.content,
					} as any,
				});
			} else if (data.type === 'tool_call') {
				this._onDidSessionProgress.fire({
					kind: 'action',
					resource: sessionUri,
					action: {
						type: ActionType.ChatToolCallStart,
						turnId: data.turn_id || generateUuid(),
						toolCallId: data.tool_call_id || generateUuid(),
						name: data.name,
						input: data.args || {},
					} as any,
				});
			} else if (data.type === 'tool_result') {
				this._onDidSessionProgress.fire({
					kind: 'action',
					resource: sessionUri,
					action: {
						type: ActionType.ChatToolCallComplete,
						turnId: data.turn_id || generateUuid(),
						toolCallId: data.tool_call_id || generateUuid(),
						result: {
							output: data.output,
						},
					} as any,
				});
			}
			return;
		}

		if (event === 'tool.pending_permission') {
			this._onDidSessionProgress.fire({
				kind: 'action',
				resource: sessionUri,
				action: {
					type: ActionType.ChatToolCallConfirmed,
					turnId: data.turn_id || generateUuid(),
					toolCallId: data.request_id || generateUuid(),
					name: data.tool,
					input: data.args || {},
				} as any,
			});
			return;
		}

		if (event === 'spawned_chat') {
			if (data.chat_id) {
				const childChatUri = this._buildChatUri(this._extractSessionId(sessionUri), data.chat_id);
				this._onDidSpawnChat.fire({
					session: sessionUri,
					chat: childChatUri,
					parent: {
						chat: chatUri,
						toolCallId: data.tool_call_id || generateUuid(),
					},
				});
			}
		}
	}

	// ---- Helpers ----

	private _buildSessionUri(sessionId: string): URI {
		return URI.from({
			scheme: 'agent-session',
			authority: MAGIS_PROVIDER_ID,
			path: `/${sessionId}`,
		});
	}

	private _buildChatUri(sessionId: string, chatId: string): URI {
		return URI.from({
			scheme: 'agent-chat',
			authority: MAGIS_PROVIDER_ID,
			path: `/${sessionId}/${chatId}`,
		});
	}

	private _buildSessionUriFromChat(chatUri: URI): URI {
		const parts = chatUri.path.split('/').filter(Boolean);
		const sessionId = parts[0] || 'default';
		return this._buildSessionUri(sessionId);
	}

	private _extractSessionId(sessionUri: URI): string {
		const parts = sessionUri.path.split('/').filter(Boolean);
		return parts[0] || sessionUri.path.replace(/^\//, '');
	}

	private _extractChatId(chatUri: URI): string {
		const parts = chatUri.path.split('/').filter(Boolean);
		return parts[parts.length - 1] || chatUri.path.replace(/^\//, '');
	}

	private _resolveModelId(modelSelection?: ModelSelection): string | undefined {
		if (!modelSelection) {
			return undefined;
		}
		if (typeof modelSelection === 'string') {
			return modelSelection;
		}
		return (modelSelection as any).id || (modelSelection as any).name;
	}

	private _remoteSessionToMetadata(remote: MagisSessionResponse): IAgentSessionMetadata {
		const sessionUri = this._buildSessionUri(remote.id);
		const timestamp = new Date(remote.created_at).getTime() || Date.now();
		return {
			session: sessionUri,
			startTime: timestamp,
			modifiedTime: timestamp,
			summary: remote.title || 'Magis Session',
		};
	}
}
