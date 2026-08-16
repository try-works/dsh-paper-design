/**
 * Paper MCP OAuth 2.1 client auth — the authorization capability Cursor's MCP
 * client performs through its OAuth layer (mcp-remote / the MCP SDK auth flow).
 *
 * Paper Desktop's bundled server is currently *unauthenticated* (localhost,
 * no OAuth discovery, no WWW-Authenticate challenge), so this manager stays
 * dormant in `unauthenticated` mode and the bridge keeps working exactly as
 * before. When a server advertises OAuth metadata (RFC 8414) or challenges a
 * request with `WWW-Authenticate` (RFC 6750 + MCP authorization), the manager
 * drives the full flow:
 *
 *   discovery → dynamic client registration (RFC 7591) → PKCE (RFC 7636)
 *   authorization via loopback redirect → token exchange → refresh on expiry,
 *
 * and hands the bearer token to the transport for every request. Tokens are
 * persisted to `$DSH_HOME/paper-design/oauth.json` so auth survives restarts.
 *
 * Everything here is best-effort: a discovery failure, a blocked redirect, or
 * a refused exchange downgrades to a surfaced status instead of breaking the
 * bridge.
 *
 * @module dsh-paper-design/src/auth
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Resolve the harness home the same way the runtime does, with sane defaults. */
export function resolvePaperStorePath(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  const home = fromEnv !== undefined && fromEnv.trim().length > 0
    ? fromEnv.trim()
    : join(homedir(), '.dsh')
  return join(home, 'paper-design', 'oauth.json')
}

/** OAuth 2.1 access/refresh token pair, as returned by the token endpoint. */
export interface PaperOAuthTokens {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

/** Dynamically-registered (or statically known) OAuth client. */
export interface PaperOAuthClient {
  client_id: string
  client_secret?: string
  redirect_uris: string[]
  token_endpoint_auth_method?: string
  client_name?: string
}

/** RFC 8414 authorization-server metadata (the subset the flow needs). */
export interface PaperOAuthMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
  response_types_supported?: string[]
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

/** Persisted auth state (tokens + client + discovery), one file per server. */
export interface PaperAuthState {
  serverUrl?: string
  tokens?: PaperOAuthTokens & { expires_at?: number }
  client?: PaperOAuthClient
  metadata?: PaperOAuthMetadata
}

export type PaperAuthMode = 'unauthenticated' | 'oauth'

/** Human-facing auth snapshot for status surfaces and commands. */
export interface PaperAuthStatus {
  mode: PaperAuthMode
  serverUrl: string
  /** A token is present on disk. */
  configured: boolean
  /** A usable access token is available (fresh or refreshable). */
  authenticated: boolean
  expiresAt?: number
  discovery?: {
    issuer?: string
    authorizationEndpoint?: string
    tokenEndpoint?: string
  }
  /** Raw WWW-Authenticate challenge captured from the last 401/403. */
  challenge?: string
  lastError?: string
}

/** Minimal transport-facing auth hook the bridge client consumes. */
export interface PaperMcpAuthProvider {
  /** Resolve (refreshing if needed) the bearer token to attach, or undefined. */
  ensureAccessToken(): Promise<string | undefined>
  /** Cached token for synchronous header assembly; undefined when none. */
  currentAccessToken(): string | undefined
  /** Record an HTTP challenge so the manager can flip into OAuth mode. */
  handleChallenge(status: number, wwwAuthenticate: string | null): void
}

/** base64url (RFC 4648 §5) over bytes — no padding. */
function base64url(input: Uint8Array): string {
  return Buffer.from(input).toString('base64url')
}

/** PKCE code verifier: 32 random bytes, base64url. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32))
}

/** PKCE S256 challenge of a verifier. */
export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

/** Opaque state for CSRF protection on the redirect. */
export function generateState(): string {
  return base64url(randomBytes(16))
}

/** GET a JSON document, or undefined on any failure/404. */
async function fetchJson(url: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch {
    return undefined
  }
  if (!res.ok) return undefined
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** RFC 8414 + OIDC discovery URL candidates for an authorization-server URL. */
export function buildDiscoveryUrls(base: string): string[] {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return []
  }
  const out: string[] = []
  const path = url.pathname === '' ? '/' : url.pathname
  if (path === '/') {
    out.push(new URL('/.well-known/oauth-authorization-server', url.origin).toString())
    out.push(new URL('/.well-known/openid-configuration', url.origin).toString())
    return out
  }
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  out.push(new URL(`/.well-known/oauth-authorization-server${trimmed}`, url.origin).toString())
  out.push(new URL(`/.well-known/openid-configuration${trimmed}`, url.origin).toString())
  out.push(new URL(`${trimmed}/.well-known/openid-configuration`, url.origin).toString())
  return out
}

/**
 * Fetch a protected-resource metadata document (RFC 9728) from an explicit URL.
 * @param documentUrl - the resource_metadata URL from a WWW-Authenticate challenge.
 * @returns the parsed document, or undefined on failure.
 */
export async function fetchProtectedResourceDocument(
  documentUrl: string,
): Promise<{ authorization_servers?: string[] } | undefined> {
  const json = await fetchJson(documentUrl)
  if (json !== undefined && typeof json === 'object' && json !== null) {
    return json as { authorization_servers?: string[] }
  }
  return undefined
}

/** RFC 9728 protected-resource metadata at the server origin (best-effort). */
export async function discoverProtectedResourceMetadata(
  serverUrl: string,
): Promise<{ authorization_servers?: string[] } | undefined> {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return undefined
  }
  const candidates: string[] = [new URL('/.well-known/oauth-protected-resource', url.origin).toString()]
  if (url.pathname !== '' && url.pathname !== '/') {
    candidates.push(new URL(`/.well-known/oauth-protected-resource${url.pathname}`, url.origin).toString())
  }
  for (const candidate of candidates) {
    const document = await fetchProtectedResourceDocument(candidate)
    if (document !== undefined) return document
  }
  return undefined
}

/** Discover RFC 8414 authorization-server metadata from a base URL. */
export async function discoverAuthorizationServerMetadata(
  base: string,
): Promise<PaperOAuthMetadata | undefined> {
  for (const candidate of buildDiscoveryUrls(base)) {
    const json = await fetchJson(candidate)
    if (json === undefined || typeof json !== 'object' || json === null) continue
    const meta = json as Record<string, unknown>
    if (typeof meta.authorization_endpoint === 'string' && typeof meta.token_endpoint === 'string') {
      const out: PaperOAuthMetadata = {
        issuer: typeof meta.issuer === 'string' ? meta.issuer : candidate,
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
      }
      if (typeof meta.registration_endpoint === 'string') out.registration_endpoint = meta.registration_endpoint
      const strArr = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
      out.code_challenge_methods_supported = strArr(meta.code_challenge_methods_supported)
      out.scopes_supported = strArr(meta.scopes_supported)
      out.response_types_supported = strArr(meta.response_types_supported)
      out.grant_types_supported = strArr(meta.grant_types_supported)
      out.token_endpoint_auth_methods_supported = strArr(meta.token_endpoint_auth_methods_supported)
      return out
    }
  }
  return undefined
}

/** Best-effort open a URL in the user's default browser. */
export function openBrowser(url: string): void {
  const platform = process.platform
  const command: [string, string[]] = platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  // Avoid capturing child output; spawn detached so the browser survives us.
  import('node:child_process').then(({ spawn }) => {
    spawn(command[0], command[1], { detached: true, stdio: 'ignore' }).unref()
  }).catch(() => {
    // The URL is still returned to the caller as text.
  })
}

/**
 * File-backed OAuth state store under the harness home. JSON document, written
 * atomically-ish (single writer; the host is the only process managing it).
 */
class PaperAuthStore {
  private readonly path: string
  constructor(path: string) {
    this.path = path
  }

  async load(): Promise<PaperAuthState | undefined> {
    try {
      const text = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(text) as unknown
      if (parsed !== null && typeof parsed === 'object') return parsed as PaperAuthState
      return undefined
    } catch {
      return undefined
    }
  }

  async save(state: PaperAuthState): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      // 0o600 parity with credentials-local so token material stays user-only
      // on POSIX; ignored on Windows.
      await writeFile(this.path, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Persistence is best-effort; the in-memory copy remains authoritative.
    }
  }

  async clear(): Promise<void> {
    try {
      await rm(this.path, { force: true })
    } catch {
      // ignore
    }
  }
}

/** In-flight loopback authorization: the server and the code it receives. */
interface PendingAuthorization {
  server: Server
  waitForCode: Promise<{ code: string; state: string }>
}

/**
 * The OAuth client manager. One instance per bridge (one server URL).
 */
export class PaperAuthManager implements PaperMcpAuthProvider {
  private mode: PaperAuthMode = 'unauthenticated'
  private metadata?: PaperOAuthMetadata
  private client?: PaperOAuthClient
  private tokens?: PaperOAuthTokens
  private expiresAt?: number
  private codeVerifier?: string
  private pending?: PendingAuthorization
  private challenge?: string
  private lastError?: string
  private readonly store: PaperAuthStore
  private readonly serverUrl: string

  constructor(
    serverUrl: string,
    storePath?: string,
  ) {
    this.serverUrl = serverUrl
    this.store = new PaperAuthStore(storePath ?? resolvePaperStorePath())
  }

  /** Load persisted state, then probe the server for OAuth metadata. */
  async init(): Promise<void> {
    const saved = await this.store.load()
    if (saved !== undefined) {
      this.tokens = saved.tokens
      this.expiresAt = saved.tokens?.expires_at
      this.client = saved.client
      this.metadata = saved.metadata
      if (saved.tokens !== undefined || saved.metadata !== undefined) this.mode = 'oauth'
    }
    await this.probe()
  }

  /** Probe discovery endpoints; flip to oauth mode only on positive evidence. */
  async probe(): Promise<void> {
    const protectedResource = await discoverProtectedResourceMetadata(this.serverUrl)
    const authServerBase = protectedResource?.authorization_servers?.[0] ?? this.serverUrl
    const metadata = await discoverAuthorizationServerMetadata(authServerBase)
    if (metadata !== undefined) {
      this.metadata = metadata
      this.mode = 'oauth'
      await this.persist()
    }
    // Otherwise leave mode as-is: a saved token can still put us in oauth mode,
    // but a fresh localhost server without discovery stays unauthenticated.
  }

  currentAccessToken(): string | undefined {
    return this.tokens?.access_token
  }

  async ensureAccessToken(): Promise<string | undefined> {
    if (this.tokens === undefined) return undefined
    if (this.expiresAt === undefined || this.expiresAt > Date.now() + 30_000) {
      return this.tokens.access_token
    }
    // Expired (or near): try refresh; keep the current token on refresh failure.
    const refreshed = await this.refresh()
    return this.tokens?.access_token ?? (refreshed ? undefined : this.tokens?.access_token)
  }

  handleChallenge(status: number, wwwAuthenticate: string | null): void {
    if (status !== 401 && status !== 403) return
    this.challenge = wwwAuthenticate ?? `HTTP ${status}`
    if (this.mode === 'unauthenticated') this.mode = 'oauth'
    // RFC 9728: the WWW-Authenticate challenge may carry resource_metadata,
    // which points at the protected-resource metadata document. Resolve the
    // authorization server through that document when present.
    const resourceMetadataUrl = parseChallengeParam(wwwAuthenticate, 'resource_metadata')
    void (async () => {
      let base = this.serverUrl
      if (resourceMetadataUrl !== undefined) {
        const document = await fetchProtectedResourceDocument(resourceMetadataUrl)
        base = document?.authorization_servers?.[0] ?? resourceMetadataUrl
      }
      const metadata = await discoverAuthorizationServerMetadata(base)
      if (metadata !== undefined) {
        this.metadata = metadata
        await this.persist()
      }
    })()
  }

  status(): PaperAuthStatus {
    const configured = this.tokens !== undefined
    const authenticated = configured && (
      this.expiresAt === undefined
      || this.expiresAt > Date.now() + 30_000
      || this.tokens?.refresh_token !== undefined
    )
    return {
      mode: this.mode,
      serverUrl: this.serverUrl,
      configured,
      authenticated,
      expiresAt: this.expiresAt,
      discovery: this.metadata !== undefined
        ? {
            issuer: this.metadata.issuer,
            authorizationEndpoint: this.metadata.authorization_endpoint,
            tokenEndpoint: this.metadata.token_endpoint,
          }
        : undefined,
      challenge: this.challenge,
      lastError: this.lastError,
    }
  }

  /**
   * Begin the authorization-code flow: discover/register the client, start a
   * loopback redirect receiver, and return the URL the user must visit.
   */
  async beginAuthorization(): Promise<{ url: string }> {
    if (this.metadata === undefined) {
      await this.probe()
      if (this.metadata === undefined) {
        this.lastError = 'Paper server does not advertise OAuth authorization metadata'
        throw new Error(this.lastError)
      }
    }
    this.codeVerifier = generateCodeVerifier()
    const state = generateState()
    const loopback = await startLoopback()
    this.pending = loopback

    // Dynamic client registration when the server offers an endpoint.
    let client = this.client
    if (client === undefined && this.metadata.registration_endpoint !== undefined) {
      client = await this.registerClient(loopback.url)
    }
    if (client === undefined) {
      // Public client fallback: no registration, redirect_uri is the loopback.
      client = {
        client_id: 'dsh-paper-design',
        redirect_uris: [loopback.url],
        token_endpoint_auth_method: 'none',
        client_name: 'DeepSeek Harness Paper bridge',
      }
      this.client = client
    }

    const authUrl = new URL(this.metadata.authorization_endpoint)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', client.client_id)
    authUrl.searchParams.set('redirect_uri', loopback.url)
    authUrl.searchParams.set('code_challenge', codeChallenge(this.codeVerifier))
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)

    // Await the redirect in the background; the caller surfaces the URL now.
    void loopback.waitForCode
      .then(({ code, state: returnedState }) => this.completeAuthorization(code, returnedState, state, loopback.url))
      .catch(() => {})
    return { url: authUrl.toString() }
  }

  /** Exchange an authorization code (PKCE) for tokens and persist them. */
  async completeAuthorization(
    code: string,
    returnedState: string,
    expectedState: string,
    redirectUri: string,
  ): Promise<void> {
    if (returnedState !== expectedState) {
      this.lastError = 'OAuth state mismatch; authorization aborted'
      return
    }
    if (this.metadata === undefined) {
      this.lastError = 'Missing authorization-server metadata'
      return
    }
    const verifier = this.codeVerifier
    if (verifier === undefined) {
      this.lastError = 'Missing PKCE code verifier'
      return
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: this.client?.client_id ?? 'dsh-paper-design',
    })
    if (this.client?.client_secret !== undefined) body.set('client_secret', this.client.client_secret)

    const tokens = await this.tokenRequest(body)
    if (tokens !== undefined) {
      this.tokens = tokens
      this.expiresAt = tokens.expires_in !== undefined
        ? Date.now() + tokens.expires_in * 1000
        : undefined
      await this.persist()
    }
  }

  /** Refresh the access token with a refresh_token, if present. */
  async refresh(): Promise<boolean> {
    if (this.tokens?.refresh_token === undefined || this.metadata === undefined) return false
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      client_id: this.client?.client_id ?? 'dsh-paper-design',
    })
    if (this.client?.client_secret !== undefined) body.set('client_secret', this.client.client_secret)
    const tokens = await this.tokenRequest(body)
    if (tokens !== undefined) {
      // Preserve the old refresh_token when the server rotates-and-omits it.
      if (tokens.refresh_token === undefined) tokens.refresh_token = this.tokens.refresh_token
      this.tokens = tokens
      this.expiresAt = tokens.expires_in !== undefined
        ? Date.now() + tokens.expires_in * 1000
        : undefined
      await this.persist()
      return true
    }
    return false
  }

  /** Drop tokens, client, and persisted state; back to unauthenticated mode. */
  async logout(): Promise<void> {
    this.tokens = undefined
    this.expiresAt = undefined
    this.codeVerifier = undefined
    this.challenge = undefined
    this.lastError = undefined
    this.mode = this.metadata !== undefined ? 'oauth' : 'unauthenticated'
    await this.store.clear()
  }

  dispose(): void {
    this.pending?.server.close()
    this.pending = undefined
  }

  // ---- internals ----

  private async registerClient(redirectUri: string): Promise<PaperOAuthClient | undefined> {
    const endpoint = this.metadata?.registration_endpoint
    if (endpoint === undefined) return undefined
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'DeepSeek Harness Paper bridge',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      })
      if (!res.ok) return undefined
      const json = (await res.json()) as Record<string, unknown>
      if (typeof json.client_id !== 'string') return undefined
      const client: PaperOAuthClient = {
        client_id: json.client_id,
        redirect_uris: Array.isArray(json.redirect_uris)
          ? json.redirect_uris.filter((x): x is string => typeof x === 'string')
          : [redirectUri],
      }
      if (typeof json.client_secret === 'string') client.client_secret = json.client_secret
      if (typeof json.token_endpoint_auth_method === 'string') {
        client.token_endpoint_auth_method = json.token_endpoint_auth_method
      }
      this.client = client
      await this.persist()
      return client
    } catch {
      return undefined
    }
  }

  private async tokenRequest(body: URLSearchParams): Promise<PaperOAuthTokens | undefined> {
    const endpoint = this.metadata?.token_endpoint
    if (endpoint === undefined) {
      this.lastError = 'Missing token endpoint'
      return undefined
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        this.lastError = `token endpoint HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`
        return undefined
      }
      const json = (await res.json()) as Record<string, unknown>
      if (typeof json.access_token !== 'string') {
        this.lastError = 'token endpoint returned no access_token'
        return undefined
      }
      const tokens: PaperOAuthTokens = {
        access_token: json.access_token,
        token_type: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
      }
      if (typeof json.expires_in === 'number') tokens.expires_in = json.expires_in
      if (typeof json.refresh_token === 'string') tokens.refresh_token = json.refresh_token
      if (typeof json.scope === 'string') tokens.scope = json.scope
      return tokens
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  private async persist(): Promise<void> {
    await this.store.save({
      serverUrl: this.serverUrl,
      tokens: this.tokens !== undefined
        ? { ...this.tokens, expires_at: this.expiresAt }
        : undefined,
      client: this.client,
      metadata: this.metadata,
    })
  }
}

/** Parse one `key="value"` pair out of a WWW-Authenticate header. */
function parseChallengeParam(header: string | null, key: string): string | undefined {
  if (header === null) return undefined
  // The key may follow the auth scheme (e.g. "Bearer resource_metadata=...")
  // or a comma separating challenge parameters. Match it anywhere.
  const match = new RegExp(`(?:^|[,\\s])${key}\\s*=\\s*"([^"]*)"`, 'i').exec(header)
  return match?.[1] ?? undefined
}

/** The loopback receiver plus the promise the auth flow awaits for the code. */
interface LoopbackHandle {
  url: string
  server: Server
  waitForCode: Promise<{ code: string; state: string }>
}

/** Start an ephemeral loopback HTTP server to receive the OAuth redirect. */
function startLoopback(): Promise<LoopbackHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        handle(req, res)
      } catch {
        // Never crash the process on a malformed redirect request.
        try {
          res.writeHead(500)
          res.end()
        } catch {
          // response already ended
        }
      }
    })

    let settleCode!: (v: { code: string; state: string }) => void
    let rejectCode!: (e: Error) => void
    const waitForCode = new Promise<{ code: string; state: string }>((res, rej) => {
      settleCode = res
      rejectCode = rej
    })

    function handle(req: IncomingMessage, res: ServerResponse): void {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:2rem">'
        + '<h2>Paper authorization complete</h2><p>You may close this tab and return to DeepSeek Harness.</p>'
        + '</body></html>',
      )
      server.close()
      if (code !== null && state !== null) settleCode({ code, state })
      else rejectCode(new Error('missing code or state in OAuth redirect'))
    }

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('loopback listen failed'))
        return
      }
      resolve({ url: `http://127.0.0.1:${address.port}/callback`, server, waitForCode })
    })
  })
}
