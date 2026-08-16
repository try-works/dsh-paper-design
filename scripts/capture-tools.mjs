// Capture the live Paper MCP tool list as a fixture.
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const MCP_URL = 'http://127.0.0.1:29979/mcp'
const rpc = async (method, params) => {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  let last = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const p = line.slice(6).trim()
    if (!p || p === '[DONE]') continue
    last = JSON.parse(p)
  }
  return last
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-paper-fixture', version: '0.1.0' },
})
const listed = await rpc('tools/list', {})
const tools = listed?.result?.tools ?? []
const outPath = 'D:/DEV/dsh-paper-design/scripts/fixtures/paper-tools.json'
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, JSON.stringify(tools, null, 2) + '\n', 'utf8')
console.log('WROTE', outPath, tools.length, 'tools')
