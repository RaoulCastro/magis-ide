import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';

const DEFAULT_SCOPES = ['openid', 'profile', 'email'];

function getClientId(): string {
	const config = vscode.workspace.getConfiguration('magis.auth');
	const configClientId = config.get<string>('clientId');
	if (configClientId) {
		return configClientId;
	}
	const envClientId = process.env.MAGIS_AUTH_CLIENT_ID;
	if (envClientId) {
		return envClientId;
	}
	return 'svc-f769afa9bdccf1d97400e4e63958cc92';
}

function getClientSecret(): string {
	const config = vscode.workspace.getConfiguration('magis.auth');
	const configClientSecret = config.get<string>('clientSecret');
	if (configClientSecret) {
		return configClientSecret;
	}
	const envClientSecret = process.env.MAGIS_AUTH_CLIENT_SECRET;
	if (envClientSecret) {
		return envClientSecret;
	}
	return 'N3sq3ZUQ1SvOvO9ObLTrmDSsrTe0EBTIYfLRg1Hvj7I6DARKHCGOXDFluB2TE__MjztjKxTqM8rCsvPKpFgEpw';
}

interface StoredSession {
	id: string;
	account: { id: string; label: string };
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	expiresAt: number;
	scopes: string[];
}

interface DpopKeyPair {
	privateKey: crypto.KeyObject;
	publicKeyJwk: { kty: string; crv: string; x: string; y: string };
}

function base64urlEncode(buffer: Buffer): string {
	return buffer.toString('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

function generatePkcePair() {
	const codeVerifier = base64urlEncode(crypto.randomBytes(32));
	const codeChallenge = base64urlEncode(
		crypto.createHash('sha256').update(codeVerifier).digest()
	);
	return { codeVerifier, codeChallenge };
}

function generateDpopKeyPair(): DpopKeyPair {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
	return {
		privateKey,
		publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
	};
}

function generateDpopProof(
	httpMethod: string,
	httpUri: string,
	keyPair: DpopKeyPair,
	accessToken?: string
): string {
	const now = Math.floor(Date.now() / 1000);
	const jti = crypto.randomUUID();

	const header = {
		typ: 'dpop+jwt',
		alg: 'ES256',
		jwk: keyPair.publicKeyJwk
	};

	const payload: Record<string, any> = {
		jti,
		htm: httpMethod.toUpperCase(),
		htu: httpUri,
		iat: now
	};

	if (accessToken) {
		const hash = crypto.createHash('sha256').update(accessToken).digest();
		payload.ath = base64urlEncode(hash);
	}

	const encodedHeader = base64urlEncode(Buffer.from(JSON.stringify(header)));
	const encodedPayload = base64urlEncode(Buffer.from(JSON.stringify(payload)));
	const message = `${encodedHeader}.${encodedPayload}`;

	const sig = crypto.sign('sha256', Buffer.from(message), {
		key: keyPair.privateKey,
		dsaEncoding: 'ieee-p1363'
	});

	return `${message}.${base64urlEncode(sig)}`;
}

export function activate(context: vscode.ExtensionContext) {
	const provider = new MagisAuthenticationProvider(context);
	context.subscriptions.push(
		vscode.authentication.registerAuthenticationProvider(
			'magis',
			'Magis Account',
			provider,
			{ supportsMultipleAccounts: false }
		)
	);
}

class MagisAuthenticationProvider implements vscode.AuthenticationProvider {
	private _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _sessionKey = 'magis-sessions-list-v3';

	constructor(private readonly _context: vscode.ExtensionContext) { }

	private get _authUrl(): string {
		const raw = vscode.workspace.getConfiguration().get<string>('magis.auth.url', 'http://10.30.0.11:8001');
		return raw.replace(/\/+$/, '');
	}

	private async _getStoredSessions(): Promise<StoredSession[]> {
		const raw = await this._context.secrets.get(this._sessionKey);
		if (!raw) {
			return [];
		}
		try {
			return JSON.parse(raw);
		} catch {
			return [];
		}
	}

	private async _saveStoredSessions(sessions: StoredSession[]): Promise<void> {
		await this._context.secrets.store(this._sessionKey, JSON.stringify(sessions));
	}

	async getSessions(scopes?: readonly string[], _options?: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
		const sessions = await this._getStoredSessions();
		const validSessions: vscode.AuthenticationSession[] = [];
		const updatedSessions: StoredSession[] = [];
		let changed = false;

		for (const session of sessions) {
			// Check if token needs refresh (expires in less than 60 seconds)
			if (Date.now() >= session.expiresAt - 60000) {
				try {
					const refreshed = await this._refreshToken(session);
					updatedSessions.push(refreshed);
					validSessions.push(this._toAuthSession(refreshed));
					changed = true;
				} catch {
					// Refresh failed, discard expired session
					changed = true;
				}
			} else {
				updatedSessions.push(session);
				validSessions.push(this._toAuthSession(session));
			}
		}

		if (changed) {
			await this._saveStoredSessions(updatedSessions);
			this._onDidChangeSessions.fire({ added: [], removed: [], changed: validSessions });
		}

		if (scopes && scopes.length > 0) {
			return validSessions.filter(s => scopes.every(scope => s.scopes.includes(scope)));
		}

		return validSessions;
	}

	async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		const effectiveScopes = Array.from(new Set([...DEFAULT_SCOPES, ...(scopes || [])]));
		const { codeVerifier, codeChallenge } = generatePkcePair();
		const state = base64urlEncode(crypto.randomBytes(16));

		// Start a local loopback HTTP server to handle the OAuth2 callback
		const { port, codePromise, server } = await this._startLoopbackServer(state);
		const redirectUri = `http://127.0.0.1:${port}/callback`;

		const authUrl = `${this._authUrl}/oauth/authorize?` + new URLSearchParams({
			response_type: 'code',
			client_id: getClientId(),
			redirect_uri: redirectUri,
			scope: effectiveScopes.join(' '),
			state: state,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256'
		}).toString();

		// Open browser for OpenID Connect login
		const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));

		let authCode: string;

		if (!opened) {
			// Fallback for headless environments: display URL and ask for manual code entry
			server.close();

			const choice = await vscode.window.showInformationMessage(
				'Impossible d\'ouvrir le navigateur automatiquement.',
				'Ouvrir l\'URL manuellement',
				'Annuler'
			);

			if (choice !== 'Ouvrir l\'URL manuellement') {
				throw new Error('Authentification annulée par l\'utilisateur.');
			}

			// Copy URL to clipboard and show it
			await vscode.env.clipboard.writeText(authUrl);

			const manualCode = await vscode.window.showInputBox({
				prompt: 'Ouvrez cette URL dans votre navigateur sur un autre appareil:',
				value: authUrl,
				valueSelection: [0, authUrl.length],
				ignoreFocusOut: true,
				validateInput: (value: string) => {
					if (!value || value.trim().length === 0) {
						return 'Veuillez entrer le code d\'autorisation.';
					}
					return null;
				}
			});

			if (!manualCode) {
				throw new Error('Authentification annulée par l\'utilisateur.');
			}

			authCode = manualCode;
		} else {
			// Browser opened successfully, wait for callback
			authCode = await vscode.window.withProgress<string>({
				location: vscode.ProgressLocation.Notification,
				title: 'Authentification Magis',
				cancellable: true
			}, async (progress, token) => {
				progress.report({ message: 'Connexion en cours dans votre navigateur...' });
				token.onCancellationRequested(() => {
					server.close();
				});
				return await codePromise;
			});

			server.close();
		}

		if (!authCode) {
			throw new Error('Code d\'autorisation non reçu.');
		}

		// Generate DPoP proof for /oauth/token endpoint
		const dpopKeyPair = generateDpopKeyPair();
		const tokenUrl = `${this._authUrl}/oauth/token`;
		const dpopProof = generateDpopProof('POST', tokenUrl, dpopKeyPair);

		// Exchange authorization code for tokens (POST /oauth/token)
		const tokenResponse = await fetch(tokenUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'DPoP': dpopProof
			},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: getClientId(),
				client_secret: getClientSecret(),
				code: authCode,
				redirect_uri: redirectUri,
				code_verifier: codeVerifier
			}).toString()
		});

		const tokenJson = await tokenResponse.json().catch(() => ({})) as any;
		if (!tokenResponse.ok || tokenJson.success === false) {
			const errorMsg = tokenJson.error_description || tokenJson.response_message || tokenJson.detail || tokenResponse.statusText;
			throw new Error(`Échec de l'échange de token Magis OIDC: ${errorMsg}`);
		}

		const tokenData = (tokenJson.response_data || tokenJson) as {
			access_token: string;
			refresh_token: string;
			id_token?: string;
			expires_in: number;
		};

		// Fetch user info (/oauth/userinfo) with DPoP header & Bearer fallback
		const userinfoUrl = `${this._authUrl}/oauth/userinfo`;
		const userinfoDpop = generateDpopProof('GET', userinfoUrl, dpopKeyPair, tokenData.access_token);

		let profileResponse = await fetch(userinfoUrl, {
			headers: {
				'Authorization': `DPoP ${tokenData.access_token}`,
				'DPoP': userinfoDpop
			}
		});

		if (!profileResponse.ok) {
			profileResponse = await fetch(userinfoUrl, {
				headers: {
					'Authorization': `Bearer ${tokenData.access_token}`,
					'DPoP': userinfoDpop
				}
			});
		}

		let userId = 'magis-user';
		let userLabel = 'Utilisateur Magis';
		if (profileResponse.ok) {
			const profJson = await profileResponse.json().catch(() => ({})) as any;
			const profile = (profJson.response_data || profJson) as {
				sub?: string;
				email?: string;
				name?: string;
				preferred_username?: string;
			};
			userId = profile.sub || profile.preferred_username || profile.email || userId;
			userLabel = profile.name || profile.preferred_username || profile.email || userId;
		}

		const newSession: StoredSession = {
			id: Math.random().toString(36).substring(2, 15),
			account: {
				id: userId,
				label: userLabel
			},
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token,
			idToken: tokenData.id_token,
			expiresAt: Date.now() + ((tokenData.expires_in || 3600) * 1000),
			scopes: effectiveScopes
		};

		const sessions = await this._getStoredSessions();
		sessions.push(newSession);
		await this._saveStoredSessions(sessions);

		this._onDidChangeSessions.fire({ added: [this._toAuthSession(newSession)], removed: [], changed: [] });
		return this._toAuthSession(newSession);
	}

	async removeSession(sessionId: string): Promise<void> {
		const sessions = await this._getStoredSessions();
		const idx = sessions.findIndex(s => s.id === sessionId);
		if (idx !== -1) {
			const removed = this._toAuthSession(sessions[idx]);
			sessions.splice(idx, 1);
			await this._saveStoredSessions(sessions);
			this._onDidChangeSessions.fire({ added: [], removed: [removed], changed: [] });
		}
	}

	private async _refreshToken(session: StoredSession): Promise<StoredSession> {
		const dpopKeyPair = generateDpopKeyPair();
		const tokenUrl = `${this._authUrl}/oauth/token`;
		const dpopProof = generateDpopProof('POST', tokenUrl, dpopKeyPair);

		const response = await fetch(tokenUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'DPoP': dpopProof
			},
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				client_id: getClientId(),
				client_secret: getClientSecret(),
				refresh_token: session.refreshToken
			}).toString()
		});

		const resJson = await response.json().catch(() => ({})) as any;
		if (!response.ok || resJson.success === false) {
			throw new Error('Échec du renouvellement du token OIDC.');
		}

		const data = (resJson.response_data || resJson) as {
			access_token: string;
			refresh_token?: string;
			id_token?: string;
			expires_in: number;
		};

		return {
			...session,
			accessToken: data.access_token,
			refreshToken: data.refresh_token || session.refreshToken,
			idToken: data.id_token || session.idToken,
			expiresAt: Date.now() + ((data.expires_in || 3600) * 1000)
		};
	}

	private _toAuthSession(session: StoredSession): vscode.AuthenticationSession {
		return {
			id: session.id,
			accessToken: session.accessToken,
			account: session.account,
			scopes: session.scopes
		};
	}

	private _startLoopbackServer(expectedState: string): Promise<{ port: number; codePromise: Promise<string>; server: http.Server }> {
		return new Promise((resolve, reject) => {
			let resolveCode: (code: string) => void;
			let rejectCode: (reason: any) => void;

			const codePromise = new Promise<string>((res, rej) => {
				resolveCode = res;
				rejectCode = rej;
			});

			const server = http.createServer((req, res) => {
				if (!req.url) {
					res.writeHead(400);
					res.end('Requête invalide.');
					return;
				}

				const reqUrl = new URL(req.url, 'http://127.0.0.1');
				if (reqUrl.pathname !== '/callback') {
					res.writeHead(404);
					res.end('Non trouvé');
					return;
				}

				const code = reqUrl.searchParams.get('code');
				const state = reqUrl.searchParams.get('state');
				const error = reqUrl.searchParams.get('error_description') || reqUrl.searchParams.get('error');

				if (error) {
					res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end(`<h2>Erreur d'authentification</h2><p>${error}</p>`);
					rejectCode(new Error(error));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end('<h2>Erreur d\'authentification</h2><p>Paramètre d\'état (state) non valide.</p>');
					rejectCode(new Error('Mismatched state parameter'));
					return;
				}

				if (!code) {
					res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end('<h2>Erreur d\'authentification</h2><p>Code d\'autorisation absent.</p>');
					rejectCode(new Error('Missing authorization code'));
					return;
				}

				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Magis IDE - Connexion réussie</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #18181b; color: #f4f4f5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #27272a; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 400px; border: 1px solid #3f3f46; }
    h2 { color: #22c55e; margin-top: 0; }
    p { color: #a1a1aa; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h2>✓ Connexion réussie !</h2>
    <p>Vous êtes maintenant authentifié sur <strong>Magis IDE</strong>.</p>
    <p>Vous pouvez fermer cet onglet et revenir dans votre IDE.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`);

				resolveCode(code);
			});

			server.listen(54321, '127.0.0.1', () => {
				const addr = server.address() as { port: number };
				resolve({ port: addr.port, codePromise, server });
			});

			server.on('error', (err: any) => {
				if (err.code === 'EADDRINUSE') {
					server.listen(0, '127.0.0.1', () => {
						const addr = server.address() as { port: number };
						resolve({ port: addr.port, codePromise, server });
					});
				} else {
					reject(err);
				}
			});
		});
	}
}
