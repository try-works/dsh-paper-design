// Verify the Paper OAuth client flow end-to-end against a mock authorization server:
// discovery → client registration → PKCE authorization (loopback) → token exchange →
// bearer attach → refresh → logout, plus the 401 challenge flip.
import { createServer, type Server } from 'node:http'
import { PaperAuthManager, buildDiscoveryUrls, generateCodeVerifier, codeChallenge } from '../src/auth.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log('OK ', name)
  else { console.error('FAIL', name, detail ?? ''); failures++ }
}

// ---- unit: PKCE + discovery URLs ----
const verifier = generateCodeVerifier()
const challenge = codeChallenge(verifier)
check('PKCE verifier length', verifier.length >= 43)
check('PKCE challenge is base64url', /^[A-Za-z0-9_-]+$/.test(challenge))
const urls = buildDiscoveryUrls('http://127.0.0.1:29979/mcp')
check('discovery candidate count', urls.length === 3)
check('RFC8414 candidate', urls[0].includes('/.well-known/oauth-authorization-server/mcp'))

// ---- mock authorization server ----
const received: Record<string, string> = {}
const grants: string[] = []
let mockOrigin = 'http://127.0.0.1'
const server: Server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', mockOrigin)
  const respond = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // Protected-resource metadata (only for the /mcp resource)
  if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    respond(200, { resource: url.origin, authorization_servers: [`${url.origin}/mcp`] })
    return
  }
  // Authorization-server discovery (only for the /mcp path)
  if (url.pathname === '/.well-known/oauth-authorization-server/mcp') {
    respond(200, {
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/token`,
      registration_endpoint: `${url.origin}/register`,
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
    })
    return
  }
  // Client registration
  if (url.pathname === '/register') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => respond(201, { client_id: 'mock-client', redirect_uris: JSON.parse(body).redirect_uris }))
    return
  }
  // Token endpoint
  if (url.pathname === '/token') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      const params = new URLSearchParams(body)
      grants.push(params.get('grant_type') ?? '')
      if (params.get('grant_type') === 'authorization_code') {
        received.code = params.get('code') ?? ''
        received.verifier = params.get('code_verifier') ?? ''
        received.redirect = params.get('redirect_uri') ?? ''
        respond(200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'mock-refresh-token' })
      } else if (params.get('grant_type') === 'refresh_token') {
        respond(200, { access_token: 'refreshed-access-token', token_type: 'Bearer', expires_in: 3600 })
      } else {
        respond(400, { error: 'unsupported_grant_type' })
      }
    })
    return
  }
  respond(404, { error: 'not found' })
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as any).port
const origin = `http://127.0.0.1:${port}`
mockOrigin = origin
const storeDir = process.env.TEMP ?? '.'

// ---- Manager A: discovery succeeds at init (server advertises OAuth at /mcp) ----
const mgrA = new PaperAuthManager(`${origin}/mcp`, `${storeDir}/paper-auth-A-${port}.json`)
await mgrA.init()
const statusA0 = mgrA.status()
check('A: discovery at init flips to oauth', statusA0.mode === 'oauth', statusA0.mode)
check('A: authorization endpoint discovered', statusA0.discovery?.authorizationEndpoint === `${origin}/authorize`)

const { url } = await mgrA.beginAuthorization()
const authUrl = new URL(url)
check('A: response_type=code', authUrl.searchParams.get('response_type') === 'code')
check('A: PKCE challenge present', authUrl.searchParams.get('code_challenge') !== null)
check('A: state present', authUrl.searchParams.get('state') !== null)
check('A: client_id=registered', authUrl.searchParams.get('client_id') === 'mock-client')
const redirectUri = authUrl.searchParams.get('redirect_uri') ?? ''
const state = authUrl.searchParams.get('state') ?? ''

// Browser hits the loopback with code + state
const cbUrl = new URL(redirectUri)
cbUrl.searchParams.set('code', 'the-auth-code')
cbUrl.searchParams.set('state', state)
const cbRes = await fetch(cbUrl.toString())
await cbRes.text()
await new Promise(r => setTimeout(r, 150))

const statusA1 = mgrA.status()
check('A: authenticated after redirect', statusA1.authenticated === true)
check('A: token exchange got code', received.code === 'the-auth-code')
check('A: token exchange got PKCE verifier', /^[A-Za-z0-9_-]{43,128}$/.test(received.verifier))
check('A: token exchange got redirect_uri', received.redirect === redirectUri)

const token = await mgrA.ensureAccessToken()
check('A: ensureAccessToken returns stored token', token === 'mock-access-token')

// Force expiry → refresh
;(mgrA as unknown as { expiresAt?: number }).expiresAt = Date.now() - 60_000
const refreshed = await mgrA.ensureAccessToken()
check('A: refresh produced new token', refreshed === 'refreshed-access-token')
check('A: refresh grant used', grants.includes('refresh_token'))

await mgrA.logout()
const statusA2 = mgrA.status()
check('A: logout clears tokens', statusA2.configured === false && statusA2.authenticated === false)
mgrA.dispose()

// ---- Manager B: no advertised OAuth; flips on a 401 challenge ----
const mgrB = new PaperAuthManager(`${origin}/not-mcp`, `${storeDir}/paper-auth-B-${port}.json`)
await mgrB.init()
const statusB0 = mgrB.status()
check('B: init stays unauthenticated (no discovery at /not-mcp)', statusB0.mode === 'unauthenticated', statusB0.mode)

mgrB.handleChallenge(401, `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`)
await new Promise(r => setTimeout(r, 150))
const statusB1 = mgrB.status()
check('B: challenge flips to oauth', statusB1.mode === 'oauth', statusB1.mode)
check('B: challenge discovered authorization endpoint', statusB1.discovery?.authorizationEndpoint === `${origin}/authorize`)
mgrB.dispose()

await new Promise<void>((resolve) => server.close(() => resolve()))

if (failures) { console.error(failures, 'failure(s)'); process.exit(1) }
console.log('PASS')
