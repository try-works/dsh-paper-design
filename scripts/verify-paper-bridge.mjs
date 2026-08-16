// Live bridge verification against the Paper Desktop MCP server.
// Usage: node scripts/verify-paper-bridge.mjs
import { readFile } from 'node:fs/promises'

const MCP_URL = 'http://127.0.0.1:29979/mcp'
const MCP_PROTOCOL = '2024-11-05'

let sessionId = null
let id = 0
async function rpc(method, params) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) { try { return JSON.parse(trimmed) } catch {} }
  let last = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const p = line.slice(6).trim()
    if (!p || p === '[DONE]') continue
    try { last = JSON.parse(p) } catch {}
  }
  return last
}

const init = await rpc('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'verify-paper-bridge', version: '0.1.0' } })
if (init.error) { console.error('INIT ERROR', init.error.message); process.exit(1) }
console.log('OK initialize', JSON.stringify(init.result?.serverInfo ?? {}))

const listed = await rpc('tools/list', {})
if (listed.error) { console.error('LIST ERROR', listed.error.message); process.exit(1) }
const tools = listed.result?.tools ?? []
console.log('OK tools/list count=', tools.length)

const filtered = tools.filter(t => t.name === 'mcp_auth')
if (filtered.length) { console.error('FAIL: mcp_auth advertised'); process.exit(1) }
console.log('OK no mcp_auth')

const basic = await rpc('tools/call', { name: 'get_basic_info', arguments: {} })
const basicText = (basic.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
if (!basicText.includes('artboards')) { console.error('FAIL: get_basic_info missing artboards'); process.exit(1) }
console.log('OK get_basic_info')

const guide = await rpc('tools/call', { name: 'get_guide', arguments: { topic: 'paper-mcp-instructions' } })
const guideText = (guide.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
if (guideText.length < 1000) { console.error('FAIL: get_guide too short', guideText.length); process.exit(1) }
console.log('OK get_guide len=', guideText.length)

// Normalize every schema without throwing
try {
  const { normalizeToolSchema } = await import('../src/schema.ts')
  for (const t of tools) normalizeToolSchema(t.inputSchema)
  console.log('OK normalize all ', tools.length, ' schemas')
} catch (e) {
  console.error('FAIL normalize', e.message); process.exit(1)
}

console.log('PASS')
