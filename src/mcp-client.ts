/**
 * Minimal Streamable HTTP MCP client for the Paper Desktop MCP server.
 *
 * Paper Desktop exposes an MCP server at http://127.0.0.1:29979/mcp over
 * Streamable HTTP (2024-11-05 protocol). This client implements exactly the
 * subset the bridge needs: initialize, notifications/initialized, tools/list,
 * and tools/call — with session-id tracking and one-shot re-initialize retry
 * on session expiry, mirroring the transport behavior the pi-paper-design
 * bridge established against the same endpoint.
 *
 * Auth: an optional {@link PaperMcpAuthProvider} supplies a bearer token that
 * is attached as `Authorization` on every request, and is notified of 401/403
 * `WWW-Authenticate` challenges so it can (re)start the OAuth flow. Without
 * a provider the client remains plain unauthenticated Streamable HTTP.
 *
 * @module dsh-paper-design/src/mcp-client
 */

import type { PaperMcpAuthProvider } from './auth.ts'

/** Paper Desktop MCP endpoint. */
export const MCP_URL = 'http://127.0.0.1:29979/mcp'

/** MCP protocol version negotiated with Paper Desktop. */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

/** One JSON-RPC error object. */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** One JSON-RPC response (result or error). */
export interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: JsonRpcError
}

/** An MCP content part (text | image | unknown). */
export type McpContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | Record<string, unknown>

/** An MCP tools/call result. */
export interface McpCallToolResult {
  content?: McpContentPart[]
  isError?: boolean
  structuredContent?: unknown
}

/** True when an error message signals the session expired and a re-init is warranted. */
export function isSessionError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('session not found')
    || m.includes('invalid session')
    || m.includes('session expired')
    || m.includes('no valid session')
  )
}

/** True when an HTTP status demands (re)authentication. */
export function isAuthChallengeStatus(status: number): boolean {
  return status === 401 || status === 403
}

/**
 * Parse an MCP Streamable HTTP response body: plain JSON or SSE frames
 * (last `data:` JSON frame wins, `[DONE]` ignored).
 * @param text - the raw response body.
 * @returns the parsed JSON-RPC response.
 */
export function parseMcpHttpBody(text: string): JsonRpcResponse {
  const trimmed = text.trim()
  if (!trimmed) {
    return { error: { code: -1, message: 'Empty response from Paper MCP server' } }
  }
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse
    } catch {
      // fall through to SSE handling
    }
  }
  let last: JsonRpcResponse | null = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      last = JSON.parse(payload) as JsonRpcResponse
    } catch {
      // ignore malformed frames
    }
  }
  if (last) return last
  return { error: { code: -1, message: 'Unrecognized Paper MCP response: ' + trimmed.slice(0, 200) } }
}

/** Minimal Streamable HTTP MCP client with session + bearer-token tracking. */
export class PaperMcpClient {
  /** Base MCP endpoint (kept for future overrides; the default is {@link MCP_URL}). */
  private readonly endpoint: string
  private auth: PaperMcpAuthProvider | undefined

  constructor(endpoint: string = MCP_URL) {
    this.endpoint = endpoint
  }

  private sessionId: string | null = null
  private idCounter = 0
  private initialized = false

  get isInitialized(): boolean {
    return this.initialized
  }

  /** Attach an OAuth provider whose bearer token rides every request. */
  setAuthProvider(provider: PaperMcpAuthProvider | undefined): void {
    this.auth = provider
  }

  resetSession(): void {
    this.sessionId = null
    this.initialized = false
  }

  /**
   * Initialize the MCP session and send the notifications/initialized ping.
   * @returns the initialize result.
   */
  async initialize(): Promise<JsonRpcResponse> {
    this.sessionId = null
    this.initialized = false
    const result = await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-paper-design', version: '0.1.0' },
    })
    if (result.error) return result
    const headers = await this.buildHeaders()
    await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    }).catch(() => {})
    this.initialized = true
    return result
  }

  /** List tools advertised by the server. */
  async listTools(): Promise<JsonRpcResponse> {
    return this.rpc('tools/list', {})
  }

  /** Call one MCP tool. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcResponse> {
    return this.rpc('tools/call', { name, arguments: args }, false, signal)
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    if (this.auth !== undefined) {
      const token = await this.auth.ensureAccessToken()
      if (token !== undefined) headers.Authorization = `Bearer ${token}`
    }
    return headers
  }

  /**
   * JSON-RPC over Streamable HTTP. Retries once after re-initialize on session errors.
   * @param method - JSON-RPC method name.
   * @param params - JSON-RPC params.
   * @param retried - whether a session-error retry already happened.
   * @param signal - optional caller cancellation forwarded to fetch.
   * @returns the parsed response.
   */
  async rpc(method: string, params: unknown, retried = false, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const id = ++this.idCounter
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: await this.buildHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      const text = await res.text()
      if (!res.ok) {
        const snippet = text.slice(0, 300)
        const message = 'HTTP ' + res.status + ' ' + res.statusText + (snippet ? ': ' + snippet : '')
        // Surface auth challenges to the provider so it can flip into OAuth mode.
        if (isAuthChallengeStatus(res.status)) {
          this.auth?.handleChallenge(res.status, res.headers.get('www-authenticate'))
        }
        if (!retried && isSessionError(message)) {
          this.resetSession()
          const init = await this.initialize()
          if (init.error) return init
          return this.rpc(method, params, true, signal)
        }
        return { error: { code: res.status, message } }
      }
      const parsed = parseMcpHttpBody(text)
      if (parsed.error && !retried && isSessionError(parsed.error.message)) {
        this.resetSession()
        const init = await this.initialize()
        if (init.error) return init
        return this.rpc(method, params, true, signal)
      }
      return parsed
    } catch (err) {
      return {
        error: { code: -1, message: (err as Error).message || 'Paper MCP connection failed' },
      }
    }
  }
}
