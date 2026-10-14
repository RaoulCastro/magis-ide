# Plan d'Intégration Magis-Agent (Dutemwo) dans Magis IDE

## Analyse Actuelle du Projet

### Structure du Fork VSCode
Le projet `/home/magis/vscode` est un fork de code-oss VSCode déjà partiellement transformé :

**Identité Magis** (déjà configurée) :
- `package.json`: name="magis-ide", author="Magis"
- `product.json`: nameShort="Magis IDE", applicationName="magis-ide"
- Extensions existantes : `magis-authentication` (authentification centralisée)

**Architecture Agent Host** (VSCode native) :
- `src/vs/platform/agentHost/` : Infrastructure d'hébergement d'agents
- `src/vs/platform/agentHost/node/` : Implémentations d'agents (claude, copilot, codex)
- `src/vs/platform/agentHost/common/` : Interfaces et protocoles communs
- `extensions/copilot/` : Extension GitHub Copilot actuelle

### Agent Host Protocol (AHP)

VSCode utilise un protocole unifié pour tous les agents :

**Composants principaux** :
- `AgentService` : Orchestrateur central (gestion sessions, chats, routing)
- `AgentHostStateManager` : Gestion d'état persistant
- `IAgent` : Interface que chaque agent doit implémenter
- WebSocket/MessagePort : Transport IPC

**Fonctionnalités supportées** :
- Multi-chat (sessions parallèles)
- Multi-session (workspace multiples)
- Tool calls (exécution d'outils)
- Subagents (agents secondaires)
- Persistence (restauration après redémarrage)

## Points d'Intégration pour Magis-Agent

### 1. Architecture de Communication

**Approche recommandée** : Intégration via HTTP (serveur existant)

Magis-Agent expose déjà un serveur HTTP dans `magis_agent/cli.py` :
```python
# Serveur existant dans Magis-Agent
def cmd_serve(args):
    # Démarrage du serveur FastAPI
    uvicorn.run(app, host="127.0.0.1", port=args.port)
```

**Avantages** :
- Pas besoin de réécrire le cœur de Magis-Agent en TypeScript
- Maintient la séparation des responsabilités (Python pour l'agent, TypeScript pour l'IDE)
- Facilite le développement et les tests
- Compatible avec l'architecture multi-langages existante

### 2. Implémentation IAgent dans VSCode

**Structure à créer** :
```
src/vs/platform/agentHost/node/dutemwo/
├── dutemwoAgent.ts          # Implémentation IAgent principale
├── dutemwoAgentSession.ts   # Gestion de session Dutemwo
├── dutemwoHttpClient.ts     # Client HTTP vers Magis-Agent
├── dutemwoToolAdapter.ts    # Adaptateur tools VSCode ↔ Magis-Agent
├── dutemwoModelConfig.ts    # Configuration des modèles
└── dutemwoSessionConfigKeys.ts  # Clés de configuration
```

**Interface IAgent à implémenter** :
```typescript
interface IAgent {
    // Gestion des sessions
    createSession(sessionId: string, options: SessionOptions): Promise<ISession>;
    getSession(sessionId: string): ISession | undefined;
    listSessions(): ISessionInfo[];
    
    // Gestion des chats (multi-chat support)
    chats: {
        createChat(chatUri: string, options?: ChatOptions): Promise<IAgentCreateChatResult>;
        disposeChat(chatUri: string): Promise<void>;
        getMessages(chatUri: string): Turn[];
        fork(chatUri: string, turnId: string): Promise<string>;
    };
    
    // Communication
    sendMessage(chatUri: string, message: Message): Promise<void>;
    abort(chatUri: string): Promise<void>;
    
    // Capabilities
    getDescriptor(): IAgentDescriptor;
}
```

### 3. Extension Dutemwo Chat

**Structure à créer** :
```
extensions/dutemwo-chat/
├── package.json              # Configuration extension
├── src/
│   ├── extension.ts          # Point d'entrée extension
│   ├── chat/                 # Interface chat UI
│   ├── completions/          # Autocomplétion inline
│   ├── authentication/      # Intégration auth Magis
│   └── configuration/        # Configuration utilisateur
└── assets/                  # Icônes, thèmes
```

**Configuration package.json** :
```json
{
  "name": "dutemwo-chat",
  "displayName": "Dutemwo AI Assistant",
  "description": "Magis-Agent (Dutemwo) integration for Magis IDE",
  "version": "1.0.0",
  "publisher": "magis",
  "engines": {
    "vscode": "^1.134.0"
  },
  "categories": ["AI", "Chat"],
  "activationEvents": [
    "onStartupFinished",
    "onLanguageModelChat:dutemwo"
  ],
  "enabledApiProposals": [
    "agentSessionsWorkspace",
    "agentsWindowConfiguration",
    "chatHooks"
  ],
  "contributes": {
    "chatParticipants": [
      {
        "id": "dutemwo",
        "name": "Dutemwo",
        "isDefault": true,
        "commands": [
          {
            "name": "explain",
            "description": "Explain selected code"
          },
          {
            "name": "fix",
            "description": "Fix issues in code"
          }
        ]
      }
    ]
  }
}
```

### 4. Configuration product.json

**Modification de defaultChatAgent** :
```json
{
  "defaultChatAgent": {
    "extensionId": "magis.dutemwo-chat",
    "chatExtensionId": "magis.dutemwo-chat",
    "documentationUrl": "https://magis.ai/docs/dutemwo",
    "provider": {
      "default": {
        "id": "magis",
        "name": "Magis"
      }
    },
    "providerExtensionId": "magis.magis-authentication"
  }
}
```

## Stratégie Git Submodule

### 1. Intégration Magis-Agent comme Submodule

**Commandes git** :
```bash
cd /home/magis/vscode
git submodule add https://github.com/RaoulCastro/Magis-Agent.git third_party/magis-agent
```

**Structure résultante** :
```
/home/magis/vscode/
├── third_party/
│   └── magis-agent/          # Submodule Magis-Agent
│       ├── magis_agent/      # Code Python
│       ├── python-tests/      # Tests
│       ├── rust-core/         # Cœur Rust (futur)
│       └── typescript-config/ # Configuration TypeScript
├── src/
├── extensions/
└── .gitmodules               # Configuration submodules
```

### 2. Gestion des Dépendances

**Build process** :
```bash
# Installation dépendances Magis-Agent
cd third_party/magis-agent
pip install -r requirements.txt

# Compilation Rust (si applicable)
cd rust-core
cargo build --release
```

**Intégration dans build VSCode** :
- Script `build/npm/postinstall.ts` pour installer dépendances Python
- Gulp task pour compiler le cœur Rust
- Variables d'environnement pour localiser Magis-Agent

### 3. Communication Inter-Process

**Architecture recommandée** :
```
Magis IDE (TypeScript)
    ↓ HTTP REST
Magis-Agent Server (Python/FastAPI)
    ↓
LLM (vLLM/OpenAI)
```

**Endpoints Magis-Agent** :
```python
# Endpoints existants à étendre
POST /api/chat           # Chat complet
POST /api/completions    # Autocomplétion
POST /api/tools/execute  # Exécution outils
GET  /api/health         # Health check
```

## Plan d'Implémentation Phasé

### Phase 1 : Infrastructure de Base (2-3 semaines)

**Objectifs** :
- Intégrer Magis-Agent comme git submodule
- Créer le client HTTP TypeScript
- Implémenter IAgent basique sans features avancées

**Tâches** :
1. `git submodule add` Magis-Agent
2. Créer `dutemwoHttpClient.ts` (client HTTP vers Magis-Agent)
3. Implémenter `DutemwoAgent` (IAgent minimal)
4. Créer extension `dutemwo-chat` basique
5. Configurer `product.json` pour Dutemwo comme agent par défaut

**Livrables** :
- Magis-Agent intégré comme submodule
- Communication HTTP fonctionnelle
- Chat basique opérationnel

### Phase 2 : Features Chat Avancées (3-4 semaines)

**Objectifs** :
- Implémenter multi-chat support
- Intégrer tool calls
- Ajouter support subagents

**Tâches** :
1. Implémenter `IAgentChats` (createChat, disposeChat, fork)
2. Créer `DutemwoToolAdapter` (mapping tools VSCode ↔ Magis-Agent)
3. Intégrer gestion subagents
4. Ajouter persistence des chats
5. Implémenter capabilities (multipleChats, fork)

**Livrables** :
- Multi-chat fonctionnel
- Tool calls opérationnels
- Subagents supportés

### Phase 3 : Autocomplétion Inline (2-3 semaines)

**Objectifs** :
- Remplacer Copilot inline completions
- Intégrer suggestions contextuelles
- Optimiser performance

**Tâches** :
1. Créer `DutemwoInlineCompletionsProvider`
2. Intégrer avec l'éditeur VSCode
3. Implémenter caching des suggestions
4. Ajouter configuration utilisateur

**Livrables** :
- Autocomplétion Dutemwo opérationnelle
- Performance acceptable (<200ms)
- Configuration flexible

### Phase 4 : Intégration Auth Magis (1-2 semaines)

**Objectifs** :
- Connecter Dutemwo avec magis-authentication
- Gérer tokens et sessions
- Sécuriser les communications

**Tâches** :
1. Intégrer avec extension `magis-authentication`
2. Gérer tokens Magis dans Dutemwo
3. Sécuriser communications HTTP
4. Implémenter refresh tokens

**Livrables** :
- Authentification Magis intégrée
- Tokens gérés automatiquement
- Communications sécurisées

### Phase 5 : Tests et Documentation (2-3 semaines)

**Objectifs** :
- Tests E2E complets
- Documentation utilisateur
- Performance tuning

**Tâches** :
1. Écrire tests E2E pour tous les features
2. Créer documentation utilisateur
3. Optimiser performance
4. Résoudre bugs et edge cases

**Livrables** :
- Suite de tests complète
- Documentation utilisateur
- Performance optimisée

## Considérations Techniques

### 1. Performance

**Optimisations recommandées** :
- Caching des réponses LLM
- Streaming des réponses longues
- Connection pooling HTTP
- Lazy loading des sessions

### 2. Sécurité

**Mesures de sécurité** :
- Validation stricte des tool calls
- Sandbox pour exécution code
- Rate limiting sur endpoints
- Encryption communications (HTTPS)

### 3. Compatibilité

**Points de compatibilité** :
- Support vLLM et OpenAI
- Fallback quand tool calls non supportés
- Gestion des erreurs robuste
- Mode offline limité

### 4. Extensibilité

**Architecture extensible** :
- Plugins pour tools personnalisés
- Models switch runtime
- Custom prompts
- MCP servers support

## Risques et Mitigations

### Risques Identifiés

1. **Performance HTTP vs IPC**
   - **Risque** : HTTP plus lent que IPC natif
   - **Mitigation** : Caching aggressif, streaming, connection pooling

2. **Complexité Multi-langages**
   - **Risque** : Debugging difficile entre Python/TypeScript
   - **Mitigation** : Logging structuré, tests E2E, monitoring

3. **Dépendance vLLM**
   - **Risque** : vLLM tool calls non supportés
   - **Mitigation** : Fallback parser déjà implémenté

4. **Migration Copilot → Dutemwo**
   - **Risque** : Perte de features existantes
   - **Mitigation** : Migration progressive, feature parity

## Next Steps Immédiats

1. **Valider l'approche HTTP** : Tester performance communication HTTP
2. **Créer git submodule** : Intégrer Magis-Agent dans vscode
3. **Prototype IAgent** : Implémenter DutemwoAgent minimal
4. **Tester chat basique** : Valider flux bout-en-bout

## Conclusion

L'intégration de Magis-Agent (Dutemwo) dans Magis IDE est techniquement faisable en utilisant l'architecture Agent Host Protocol existante de VSCode. L'approche recommandée est :

- **Communication HTTP** : Maintient séparation des langages et simplifie développement
- **Git submodule** : Intégration propre de Magis-Agent dans le projet
- **Implémentation IAgent** : Interface standard VSCode pour agents
- **Extension dédiée** : `dutemwo-chat` pour l'intégration UI

Cette approche permet de remplacer efficacement Copilot par Dutemwo tout en maintenant la flexibilité et l'extensibilité de l'architecture VSCode.
