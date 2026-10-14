# Magis IDE - Architecture Complète et Analyse Détaillée

**Date**: 9 octobre 2026
**Version**: 1.134.0
**Base**: Fork de VSCode (code-oss)

---

## Table des Matières

1. [Vue d'Ensemble](#vue-densemble)
2. [Structure du Projet](#structure-du-projet)
3. [Extensions Magis](#extensions-magis)
4. [Intégration Agent Host](#intégration-agent-host)
5. [Configuration](#configuration)
6. [Modifications Core VSCode](#modifications-core-vscode)
7. [Build System](#build-system)
8. [Tests](#tests)
9. [Flux d'Exécution](#flux-dexécution)
10. [Dépendances Externes](#dépendances-externes)
11. [Points d'Attention](#points-dattention)

---

## Vue d'Ensemble

Magis IDE est un fork de VSCode (code-oss) intégrant deux microservices pour l'IA:

- **magis-agent-service**: Service d'agents IA (LangGraph + vLLM + Qwen)
- **magis-authentication**: Service d'authentification (Django + OAuth2/OIDC + JWT ES256)

### Stack Technique

- **IDE**: TypeScript, Electron 42.8.0, Node.js 24.x
- **Agent Service**: FastAPI, LangGraph, LangChain, PostgreSQL, vLLM (via LiteLLM)
- **Authentication**: Django 5.2, DRF 3.17, PostgreSQL 16, Redis 7, JWT ES256

---

## Structure du Projet

### Racine (/home/magis/vscode)

#### package.json
```json
{
  "name": "magis-ide",
  "desktopName": "magis-ide.desktop",
  "version": "1.134.0",
  "author": { "name": "Magis" },
  "main": "./out/main.js",
  "type": "module"
}
```

**Scripts clés**:
- `npm run compile`: Compilation complète (client + extensions)
- `npm run watch`: Mode développement avec surveillance
- `npm run test`: Tests unitaires

**Dépendances principales**:
- Electron 42.8.0
- @anthropic-ai/sdk ^0.82.0
- @github/copilot 1.0.79-9
- @vscode/* (packages internes VSCode)
- Playwright, TypeScript 6.0.2

#### product.json
```json
{
  "nameShort": "Magis IDE",
  "nameLong": "Magis IDE",
  "applicationName": "magis-ide",
  "dataFolderName": ".magis-ide",
  "defaultChatAgent": {
    "extensionId": "magis.magis-chat",
    "chatExtensionId": "magis.magis-chat",
    "provider": {
      "default": { "id": "magis", "name": "Magis" },
      "enterprise": { "id": "magis-enterprise", "name": "Magis Enterprise" }
    }
  },
  "trustedExtensionAuthAccess": {
    "magis": ["magis.magis-chat"]
  }
}
```

**Thèmes personnalisés**:
- Magis Dark (Dark 2026)
- Magis Light (Light 2026)

---

## Extensions Magis

### 1. magis-authentication

**Emplacement**: `/home/magis/vscode/extensions/magis-authentication/`

#### package.json
```json
{
  "name": "magis-authentication",
  "displayName": "Magis Authentication",
  "version": "1.0.0",
  "publisher": "magis",
  "contributes": {
    "authentication": [{
      "id": "magis",
      "label": "Magis Account"
    }],
    "configuration": [{
      "properties": {
        "magis.auth.url": {
          "type": "string",
          "default": "http://10.30.0.11:8001",
          "markdownDescription": "URL de base du microservice d'authentification Magis"
        }
      }
    }]
  }
}
```

#### extension.ts (15 204 octets)

**Fonctionnalités principales**:

1. **OAuth2/OIDC avec PKCE et DPoP**
   - CLIENT_ID: `svc-f769afa9bdccf1d97400e4e63958cc92`
   - CLIENT_SECRET: stocké dans `resources/keys/service_private_key.pem`
   - Scopes par défaut: `['openid', 'profile', 'email']`

2. **Génération PKCE**
   ```typescript
   function generateCodeVerifier(): string {
     const array = new Uint8Array(32);
     crypto.getRandomValues(array);
     return base64UrlEncode(array);
   }

   function generateCodeChallenge(verifier: string): string {
     const encoder = new TextEncoder();
     const data = encoder.encode(verifier);
     return base64UrlEncode(await crypto.subtle.digest('SHA-256', data));
   }
   ```

3. **Génération DPoP (Demonstrating Proof-of-Possession)**
   - Clé asymétrique générée localement
   - Proof JWT signé pour chaque requête

4. **Fallback pour environnements headless** (RÉCENTEMENT AJOUTÉ)
   ```typescript
   const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));

   if (!opened) {
     // Fallback: afficher URL et demander code manuel
     await vscode.env.clipboard.writeText(authUrl);
     const manualCode = await vscode.window.showInputBox({
       prompt: 'Ouvrez cette URL dans votre navigateur sur un autre appareil:',
       value: authUrl,
       valueSelection: [0, authUrl.length],
       ignoreFocusOut: true
     });
     authCode = manualCode;
   }
   ```

5. **Loopback HTTP Server**
   - Port aléatoire (3000-9000)
   - Capture du callback OAuth2
   - HTML réponse de succès

6. **Gestion des tokens**
   - Stockage dans `vscode.authentication.getSession`
   - Refresh automatique avant expiration
   - Récupération du profil utilisateur

**Points d'attention**:
- Client ID/Secret hardcoded (sécurité)
- DPoP key locale (sécurité)
- Timeout loopback server: 120 secondes

---

### 2. magis-chat

**Emplacement**: `/home/magis/vscode/extensions/magis-chat/`

#### package.json
```json
{
  "name": "magis-chat",
  "displayName": "Magis AI Assistant",
  "id": "magis.magis-chat",
  "enabledApiProposals": [
    "agentSessionsWorkspace",
    "agentsWindowConfiguration",
    "chatHooks",
    "defaultChatParticipant",
    "chatParticipantPrivate"
  ],
  "contributes": {
    "chatParticipants": [{
      "id": "magis",
      "name": "Magis",
      "isDefault": true,
      "commands": [
        { "name": "new", "description": "Démarrer une nouvelle conversation" },
        { "name": "help", "description": "Afficher l'aide Magis" },
        { "name": "explain", "description": "Expliquer le code sélectionné" },
        { "name": "fix", "description": "Corriger les problèmes dans le code" },
        { "name": "review", "description": "Réviser les changements de code" },
        { "name": "test", "description": "Générer des tests unitaires" },
        { "name": "refactor", "description": "Refactoriser le code sélectionné" }
      ]
    }],
    "configuration": {
      "properties": {
        "magis.baseUrl": { "default": "http://localhost:8787" },
        "magis.vllmUrl": { "default": "https://ia.magis.bi/v1" },
        "magis.model": { "default": "qwen-code" },
        "magis.autoApproveReads": { "default": true }
      }
    }
  }
}
```

#### extension.ts (12 118 octets)

**Architecture**:

1. **MagisAgentClient** - Client HTTP vers magis-agent-service
   ```typescript
   class MagisAgentClient {
     private _authToken: string | undefined;
     private _sessionId: string | undefined;
     private _chatId: string | undefined;

     async refreshAuthToken(): Promise<void> {
       const session = await vscode.authentication.getSession('magis', [], { createIfNone: false });
       this._authToken = session?.accessToken;
     }

     async sendMessage(userMessage: string, context: vscode.ChatContext, onChunk: (chunk: StreamChunk) => void, signal: AbortSignal): Promise<void>
   }
   ```

2. **Streaming SSE** - Fonction `streamRequest()`
   - Utilise modules natifs `http`/`https`
   - Parse Server-Sent Events
   - Support AbortSignal pour annulation

3. **Types de chunks**:
   ```typescript
   interface StreamChunk {
     kind: 'markdown' | 'tool.start' | 'tool.end' | 'error' | 'turn.end';
     text?: string;
     tool?: string;
     input?: unknown;
     output?: string;
     status?: string;
     message?: string;
   }
   ```

4. **Chat Participant Handler**
   - Gestion des commandes `/new`, `/help`
   - Affichage progressif des réponses
   - Gestion des erreurs 401 (prompt sign-in)
   - Mise à jour dynamique de la configuration

5. **Commandes VSCode**
   - `magis.signIn`: Connexion manuelle
   - `magis.newChat`: Nouvelle conversation

**Points d'attention**:
- Pas de retry sur erreur réseau
- Historique limité aux 3 derniers échanges
- Gestion d'erreur 401 basique

---

## Intégration Agent Host

### Emplacement: `/home/magis/vscode/src/vs/platform/agentHost/node/magis/`

#### 1. magisAgent.ts (19 593 octets)

**Implémentation de l'interface `IAgent`**

```typescript
export class MagisAgent extends Disposable implements IAgent {
  readonly id = 'magis';

  private readonly httpClient: MagisHttpClient;
  private readonly _sessions = new Map<string, SessionRecord>();
  private readonly _activeAbortControllers = new Map<string, AbortController>();
  private readonly _activeClients = new Map<string, IActiveClient>();
}
```

**MAGIS_PROTECTED_RESOURCE**:
```typescript
const MAGIS_PROTECTED_RESOURCE: ProtectedResourceMetadata = {
  resource: 'magis-agent-service',
  resource_name: 'Magis Agent Service',
  authorization_servers: ['http://10.30.0.11:8001'],  // CORRIGÉ
  scopes_supported: ['chat', 'tools'],
  required: true,
};
```

**Fonctionnalités principales**:

1. **Gestion des sessions**
   - `createSession()`: Crée session sur backend
   - `listSessions()`: Liste sessions distantes
   - `getSession()`: Récupère métadonnées session
   - `disposeSession()`: Supprime session et chats

2. **Gestion des chats**
   - `createChat()`: Crée chat dans session
   - `fork()`: Fork chat depuis un turn
   - `disposeChat()`: Supprime chat
   - `sendMessage()`: Envoie message avec streaming SSE
   - `abort()`: Annule message en cours
   - `changeModel()`: Change modèle
   - `getMessages()`: Récupère historique

3. **Mapping SSE → AgentSignal**
   ```typescript
   private _handleSseEvent(sessionUri: URI, chatUri: URI, sseEvent: MagisSseEvent): void {
     if (event === 'turn.start') {
       this._onDidSessionProgress.fire({
         kind: 'action',
         action: { type: ActionType.ChatTurnStarted, turnId: data.turn_id }
       });
     }
     if (event === 'part.delta') {
       if (data.type === 'markdown') {
         this._onDidSessionProgress.fire({
           kind: 'action',
           action: { type: ActionType.ChatDelta, delta: data.content }
         });
       }
     }
     // ... tool.start, tool.end, tool.pending_permission, spawned_chat
   }
   ```

4. **Permissions**
   - `respondToPermissionRequest()`: Répond aux demandes de permission
   - `respondToUserInputRequest()`: Non implémenté

5. **Authentification**
   ```typescript
   async authenticate(resource: string, token: string): Promise<boolean> {
     if (token) {
       this.setAuthToken(token);
       this.refreshModels().catch(() => {});
       return true;
     }
     return false;
   }
   ```

6. **Modèles**
   - `refreshModels()`: Récupère modèles depuis `/models`
   - Fallback sur `qwen-code` si liste vide

**Points d'attention**:
- `respondToUserInputRequest` non implémenté
- Pas de cache local des modèles
- Gestion d'erreur basique sur refreshModels

---

#### 2. magisHttpClient.ts (8 458 octets)

**Client HTTP natif utilisant `http`/`https`**

```typescript
export class MagisHttpClient {
  private _baseUrl: string;
  private _authToken?: string;
  private readonly _timeout: number;

  constructor(config: MagisHttpClientConfig) {
    this._baseUrl = config.baseUrl.replace(/\/$/, '');
    this._authToken = config.authToken;
    this._timeout = config.timeout ?? 120_000;
  }
}
```

**API endpoints**:

**Sessions**:
- `createSession(workspacePath?, title?)`: POST `/sessions`
- `listSessions()`: GET `/sessions`
- `getSession(sessionId)`: GET `/sessions/{id}`
- `deleteSession(sessionId)`: DELETE `/sessions/{id}`

**Chats**:
- `createChat(sessionId, model?)`: POST `/sessions/{id}/chats`
- `forkChat(chatId, sourceTurnId?)`: POST `/chats/{id}/fork`
- `deleteChat(chatId)`: DELETE `/chats/{id}`
- `changeModel(chatId, model)`: POST `/chats/{id}/model`
- `abortChat(chatId)`: POST `/chats/{id}/abort`

**Messages & Turns**:
- `streamMessage(chatId, message, model, onEvent, signal?)`: POST `/chats/{id}/messages` (SSE)
- `getTurns(chatId)`: GET `/chats/{id}/turns`

**Permissions**:
- `respondToPermission(requestId, approved)`: POST `/permissions/{id}`

**Models**:
- `getModels()`: GET `/models`

**Streaming SSE**:
```typescript
streamMessage(chatId, message, model, onEvent, signal): Promise<void> {
  const headers = this._getHeaders({ Accept: 'text/event-stream' });

  res.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (trimmed.startsWith('event:')) {
        currentEvent = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.slice(5).trim();
        const parsed = JSON.parse(dataStr);
        onEvent({ event: currentEvent, data: parsed });
      }
    }
  });
}
```

**Points d'attention**:
- Timeout par défaut: 120 secondes
- Pas de retry automatique
- Pas de connection pooling

---

#### 3. magisAgentStarter.ts (1 230 octets)

**Factory pour créer l'agent Magis**

```typescript
export class MagisAgentStarter {
  constructor(
    @ILogService private readonly logService: ILogService,
    @IRequestService private readonly requestService: IRequestService,
  ) {}

  async createAgent(): Promise<IAgent> {
    const baseUrl = process.env.MAGIS_AGENT_BASE_URL || 'http://localhost:8787';
    const authToken = process.env.MAGIS_AGENT_API_KEY;

    this.logService.info('[MagisAgentStarter] Creating Magis agent with baseUrl:', baseUrl);

    const agent = new MagisAgent(
      { baseUrl, authToken },
      this.requestService
    );

    return agent;
  }

  getProviderId(): string {
    return 'magis';
  }

  isEnabled(): boolean {
    return true;
  }
}
```

**Points d'attention**:
- Toujours activé (`isEnabled: true`)
- Utilise variables d'environnement
- Non utilisé dans le code actuel (agent créé directement dans agentHostMain)

---

## Configuration

### magisConfig.contribution.ts

**Emplacement**: `/home/magis/vscode/src/vs/platform/agentHost/common/magisConfig.contribution.ts`

```typescript
configurationRegistry.registerConfiguration({
  id: 'chatAgentHostMagis',
  title: "Magis Agent Host",
  properties: {
    'chat.agentHost.magis.enabled': {
      type: 'boolean',
      description: "When enabled, the agent host registers the Magis provider",
      default: true,
      tags: ['experimental'],
    },
    'chat.agentHost.magis.baseUrl': {
      type: 'string',
      description: "Base URL of the Magis Agent Service",
      default: 'http://localhost:8787',
      tags: ['experimental'],
    },
    'chat.agentHost.magis.model': {
      type: 'string',
      description: "Default model to use for Magis chat sessions",
      default: 'qwen-code',
      tags: ['experimental'],
    },
  },
});
```

**Points d'attention**:
- Configuration non utilisée dans agentHostMain (hardcoded)
- Tag 'experimental' sur toutes les propriétés

---

## Modifications Core VSCode

### 1. Authentification Désactivée

**GitHub Authentication** (`extensions/github-authentication/src/extension.ts`):
```typescript
export function activate(_context: vscode.ExtensionContext) {
	console.log('[GitHub Auth] Disabled in Magis IDE — Magis Authentication is the sole auth provider.');
}
```

**Microsoft Authentication** (`extensions/microsoft-authentication/src/extension.ts`):
```typescript
export function activate(_context: vscode.ExtensionContext) {
	console.log('[Microsoft Auth] Disabled in Magis IDE — Magis Authentication is the sole auth provider.');
}
```

**Observation**: GitHub et Microsoft auth sont explicitement désactivés pour forcer l'utilisation de Magis Authentication comme seul provider.

### 2. agentHostMain.ts

**Emplacement**: `/home/magis/vscode/src/vs/platform/agentHost/node/agentHostMain.ts`

**Lignes 243-252**:
```typescript
// Register ONLY Magis agent for Magis IDE — sole AI assistant
const magisBaseUrl = process.env.MAGIS_AGENT_BASE_URL || 'http://localhost:8787';
agentService.registerProvider(new MagisAgent(
  {
    baseUrl: magisBaseUrl,
    authToken: process.env.MAGIS_AGENT_API_KEY,
  },
  networkServices.requestService
));
logService.info('Magis agent registered as sole provider with baseUrl:', magisBaseUrl);
```

**Import**:
```typescript
import { MagisAgent } from './magis/magisAgent.js';
```

**Observation**: Copilot, Claude et Codex sont désactivés/commentés. Seul Magis est enregistré.

---

### 2. agentHostServerMain.ts

**Emplacement**: `/home/magis/vscode/src/vs/platform/agentHost/node/agentHostServerMain.ts`

**Lignes 314-325**:
```typescript
// Register ONLY Magis agent for Magis IDE — sole AI assistant
const magisBaseUrl = process.env.MAGIS_AGENT_BASE_URL || 'http://localhost:8787';
const magisAgent = disposables.add(new MagisAgent(
  {
    baseUrl: magisBaseUrl,
    authToken: process.env.MAGIS_AGENT_API_KEY,
  },
  networkServices.requestService,
  logService,
));
agentService.registerProvider(magisAgent);
log(`MagisAgent registered as sole provider with baseUrl: ${magisBaseUrl}`);
```

**Observation**: Même logique que agentHostMain pour le mode serveur distant.

---

### 3. MagisLMProvider dans Copilot BYOK

**Emplacement**: `/home/magis/vscode/extensions/copilot/src/extension/byok/vscode-node/magisProvider.ts`

**Intégration BYOK (Bring Your Own Key)**:
```typescript
export class MagisLMProvider extends AbstractOpenAICompatibleLMProvider<MagisProviderConfig> {
	public static readonly providerName = 'Magis';
	public static readonly providerId = this.providerName.toLowerCase();

	protected override getModelsBaseUrl(configuration?: MagisProviderConfig): string {
		const configUrl = this._configurationService.getValue<string>('magis.ai.endpoint');
		if (configUrl) {
			return configUrl;
		}
		return 'http://127.0.0.1:8000/v1'; // Default local vLLM / gateway
	}

	protected override async configureDefaultGroupWithApiKeyOnly(): Promise<string | undefined> {
		try {
			const session = await vscode.authentication.getSession('magis', ['read:user'], { silent: true });
			return session?.accessToken;
		} catch {
			return undefined;
		}
	}

	protected override async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<MagisProviderConfig>): Promise<OpenAIEndpoint> {
		let token = '';
		try {
			const session = await vscode.authentication.getSession('magis', ['read:user'], { silent: true });
			if (session) {
				token = session.accessToken;
			}
		} catch (err) {
			this._logService.error('MagisLMProvider: Error fetching magis auth session', err);
		}
		// ...
	}
}
```

**Enregistrement dans BYOK** (`byokContribution.ts`):
```typescript
const magis = instantiationService.createInstance(MagisLMProvider, {}, this._byokStorageService);
this._providers.set(MagisLMProvider.providerId, magis);
```

**Observation**: Magis est intégré comme provider BYOK dans Copilot, permettant d'utiliser Magis comme backend OpenAI-compatible pour les modèles de langage.

### 4. Chat Service Modifications

**Fichiers modifiés** (branding "Magis AI"):

- `chatSetupProviders.ts`: "Sign in to use Magis AI"
- `chatSetupRunner.ts`: "Sign in to use Magis AI"
- `chatSetupContributions.ts`: "Sign in to use Magis AI...", "Magis Sign In", "Manage Magis Account", "Manage Magis Budget"
- `agentHostAuth.ts`: "Sign in to use Magis AI", "Failed to sign in to use Magis AI"
- `sessionTypeAvailability.ts`: "Sign in to Magis AI", "Upgrade your Magis AI plan", "Requires Magis AI Pro"
- `modelPickerItemSections.ts`: "Sign in to use Magis AI", "Sign in to Magis AI to choose a model", "Upgrade to Magis AI Pro"
- `chatErrorMessages.ts`: "Sorry, Magis AI Chat is currently experiencing high demand"
- `onboardingVariationA.ts`: "Welcome to Magis IDE", "Sign in to use Magis AI", "Continue with Magis", "Magis Enterprise"

**Icone**: `chatSetup/media/magis.svg`

---

### 5. Thèmes Magis

**product.json - onboardingThemes**:
```json
"onboardingThemes": [
  {
    "id": "dark-2026",
    "label": "Magis Dark",
    "themeId": "Dark 2026",
    "type": "dark"
  },
  {
    "id": "light-2026",
    "label": "Magis Light",
    "themeId": "Light 2026",
    "type": "light"
  },
  // ... autres thèmes
]
```

**Observation**: Magis IDE utilise les thèmes "Dark 2026" et "Light 2026" comme thèmes par défaut, renommés "Magis Dark" et "Magis Light" dans l'onboarding.

---

### 6. Workbench HTML Modifications

**Fichiers**:
- `vs/code/browser/workbench/workbench-dev.html`
- `vs/code/browser/workbench/workbench.html`

**Modifications**:
```html
<meta name="apple-mobile-web-app-title" content="Magis IDE">
<link rel="apple-touch-icon" href="{{WORKBENCH_WEB_BASE_URL}}/resources/server/magis-192.png" />
```

---

## Build System

### Structure build/

**gulpfile.ts**:
```typescript
const _compileTask = task.define('compile', task.parallel(
  monacoTypecheckTask,
  compileClientTask,
  compileExtensionsTask,
  compileExtensionMediaTask
));
```

**Tâches principales**:
- `compile-client`: Compilation TypeScript → out/
- `compile-extensions`: Compilation extensions
- `watch`: Surveillance pour développement
- `transpile-client`: Transpilation rapide

**package.json (build/)**:
- esbuild 0.27.2
- gulp, gulp-*
- tree-sitter
- @vscode/vsce 3.6.1

**Extensions compilation**:
- `gulpfile.extensions.ts`: Gère compilation des extensions
- magis-authentication compilé via `gulp compile-extension:magis-authentication`
- magis-chat compilé via `tsc -p ./`

---

## Configuration VSCode

### .vscode/settings.json

**Configuration principale**:
- Chat tools auto-approve pour scripts de test
- TypeScript/JavaScript format on save
- Git branch protection (main, distro, release/*)
- GitHub Pull Requests avec coding agent enabled
- Azure MCP pour Kusto
- Agent skills locations (.github/skills, .agents/skills, .claude/skills)

### .vscode/launch.json

**Configurations de debug**:
- "Launch Magis IDE Internal": Lancement avec inspect-brk sur port 5875
- "Launch Magis IDE Agents Internal": Lancement avec flag --agents
- "Launch Magis IDE Internal (Hot Reload)": Mode développement avec Vite
- userDataDir: `${userHome}/.magis-ide-dev`

### .vscode/tasks.json

**Tâches principales**:
- "Install & Watch (Client)": Installation + compilation + watch
- "Run Dev Agents": Lancement avec --agents et user-data-dir personnalisé
- "Run and Compile Magis IDE": Transpile + Run Dev
- "VS Code - Build": Build parallèle (Core, Ext, Copilot)

### scripts/code.sh

**Script de lancement**:
- Lit product.json pour déterminer le nom de l'exécutable
- Sur macOS: `.build/electron/Magis IDE.app/Contents/MacOS/Magis IDE`
- Sur Linux: `.build/electron/magis-ide`
- Exécute preLaunch.ts avant le lancement
- Configure VSCODE_DEV, VSCODE_CLI, ELECTRON_ENABLE_LOGGING

---

## Tests

### Analyse

**Recherche de tests Magis**: Aucun test spécifique trouvé dans `/home/magis/vscode/test/`

**Tests VSCode existants**:
- 55 fichiers `.test.ts` dans `src/`
- Tests agent host dans `src/vs/platform/agentHost/test/`
- Tests serveur dans `src/vs/server/test/`

**Observation**: Pas de tests unitaires pour les composants Magis (magisAgent, magisHttpClient, magis-authentication, magis-chat).

---

## Flux d'Exécution

### 1. Authentification

```
User → VSCode → magis-authentication (OAuth2/OIDC + PKCE + DPoP)
         ↓
    Obtention access token JWT ES256
         ↓
    Stockage dans vscode.authentication.getSession
```

**Détail**:
1. Extension magis-authentication intercepte demande de session
2. Génération code verifier/challenge PKCE
3. Génération clé DPoP
4. Construction URL authorization avec params
5. Tentative `vscode.env.openExternal(authUrl)`
6. Si échec (headless): fallback manuel avec input box
7. Loopback server écoute callback
8. Échange code → token via POST /oauth/token
9. Stockage token et refresh token

### 2. Chat Complet

```
User tape message
    ↓
Extension magis-chat récupère token (magis-authentication)
    ↓
POST /chats/{id}/messages avec Authorization: Bearer <token>
    ↓
magis-agent-service vérifie JWT localement via JWKS
    ↓
Charge état LangGraph
    ↓
Exécute agent_node → tools_node avec permissions
    ↓
Stream SSE events (markdown, toolCall, toolResult)
    ↓
IDE affiche en temps réel
```

### 3. Permissions

```
Agent demande tool execution
    ↓
Permission system évalue règles
    ↓
Si ASK → interrupt() graph
    ↓
SSE émet inputRequest event
    ↓
IDE affiche dialogue approbation
    ↓
POST /permissions/{request_id}
    ↓
Graph resume avec décision
```

---

## Dépendances Externes

### Microservices

**magis-agent-service** (non présent dans workspace VSCode):
- Emplacement: `/home/magis/magis-agent-service` (probable)
- Stack: FastAPI, LangGraph, LangChain, PostgreSQL, vLLM
- Configuration: MAGIS_HOST, MAGIS_PORT, MAGIS_LLM_BASE_URL, MAGIS_AUTH_URL

**magis-authentication** (non présent dans workspace VSCode):
- Emplacement: `/home/magis/Magis/magis-authentication`
- Stack: Django 5.2, DRF 3.17, PostgreSQL 16, Redis 7
- Configuration: AUTH_DB_*, REDIS_URL, JWT_PRIVATE_KEY_PATH

### URLs par défaut

- **Auth**: `http://10.30.0.11:8001` (test), `https://id.ihela.bi` (prod)
- **Agent Service**: `http://localhost:8787`
- **vLLM**: `https://ia.magis.bi/v1`

---

## Points d'Attention

### Sécurité

1. **Credentials hardcoded**
   - CLIENT_ID dans extension.ts
   - CLIENT_SECRET dans fichier PEM
   - Risque: exposition si code source leak

2. **DPoP key locale**
   - Clé générée localement non persistée
   - Risque: perte de preuve si session perdue

3. **Pas de validation JWT côté client**
   - Confiance totale dans le backend
   - Risque: MITM si HTTPS non forcé

### Performance

1. **HTTP vs IPC**
   - Communication HTTP vers microservices
   - Plus lent que IPC natif
   - Pas de connection pooling

2. **Streaming SSE**
   - Pas de retry automatique
   - Timeout fixe 120s
   - Pas de backpressure

3. **Pas de cache**
   - Modèles rechargés à chaque refresh
   - Pas de cache local des sessions

### Robustesse

1. **Gestion d'erreur basique**
   - Pas de retry sur erreur réseau
   - Pas de circuit breaker
   - Pas de timeout configurable

2. **Tests manquants**
   - Aucun test unitaire Magis
   - Pas de tests E2E
   - Pas de tests d'intégration

3. **Fallback limité**
   - Fallback headless implémenté
   - Mais pas de fallback offline
   - Pas de mode dégradé

### Architecture

1. **Couplage fort**
   - URLs hardcoded
   - Configuration non utilisée
   - MagisAgentStarter non utilisé

2. **Code dupliqué**
   - Enregistrement agent dans agentHostMain et agentHostServerMain
   - Logique SSE dupliquée entre magis-chat et magisHttpClient

3. **Fonctionnalités incomplètes**
   - `respondToUserInputRequest` non implémenté
   - Pas de support vision
   - Pas de mode offline

---

## Recommandations

### Court terme

1. **Sécurité**
   - Déplacer credentials dans variables d'environnement
   - Implémenter validation JWT côté client
   - Forcer HTTPS en production

2. **Robustesse**
   - Ajouter retry avec exponential backoff
   - Implémenter circuit breaker
   - Rendre timeout configurable

3. **Tests**
   - Écrire tests unitaires pour magisHttpClient
   - Écrire tests unitaires pour magisAgent
   - Écrire tests E2E pour le flux complet

### Moyen terme

1. **Performance**
   - Implémenter connection pooling
   - Ajouter cache local pour modèles
   - Optimiser parsing SSE

2. **Architecture**
   - Utiliser magisConfig.contribution
   - Centraliser enregistrement agent
   - Réduire duplication code

3. **Fonctionnalités**
   - Implémenter respondToUserInputRequest
   - Ajouter support vision
   - Implémenter mode offline

### Long terme

1. **Observabilité**
   - Ajouter logging structuré
   - Implémenter métriques (Prometheus)
   - Ajouter tracing (OpenTelemetry)

2. **Scalabilité**
   - Support multi-tenancy
   - Load balancing agent service
   - Sharding sessions

3. **Extensibilité**
   - Plugin system pour tools
   - Custom models support
   - Multi-provider support

---

## Conclusion

Magis IDE est un fork de VSCode bien intégré avec deux microservices pour l'IA. L'architecture est solide mais présente plusieurs points d'amélioration en termes de sécurité, performance et robustesse. Les modifications core VSCode sont minimales et bien localisées, ce qui facilite la maintenance. L'absence de tests est un point critique à adresser rapidement.

**État actuel**: Fonctionnel mais nécessite des améliorations pour la production.
