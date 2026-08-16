import { PaperMcpClient, MCP_URL, type McpCallToolResult } from '../src/mcp-client.ts'
import { normalizeToolSchema } from '../src/schema.ts'
import { extractGuideText } from '../src/guide.ts'

const client = new PaperMcpClient(MCP_URL)
const init = await client.initialize()
console.log('INIT error:', JSON.stringify(init.error))
const listed = await client.listTools()
console.log('LIST error:', JSON.stringify(listed.error))
const tools = (listed.result as any)?.tools ?? []
console.log('TOOL COUNT:', tools.length)
const names = tools.map((t: any) => t.name)
console.log('NAMES:', names.slice(0, 8).join(', '), '…')
const basic = await client.callTool('get_basic_info', {}, undefined)
console.log('BASIC error:', JSON.stringify(basic.error))
const result = basic.result as McpCallToolResult | undefined
const text = result?.content?.[0] && (result.content[0] as any).type === 'text' ? (result.content[0] as any).text : ''
console.log('BASIC text len:', text.length)
console.log('BASIC snippet:', text.slice(0, 180))
const guide = await client.callTool('get_guide', { topic: 'paper-mcp-instructions' }, undefined)
const guideResult = guide.result as McpCallToolResult | undefined
const guideText = extractGuideText(guideResult)
console.log('GUIDE text len:', guideText?.length ?? 0)
if (guideText) console.log('GUIDE head:', guideText.slice(0, 140))
// Schema normalization on a live tool
const getScreenshot = tools.find((t: any) => t.name === 'get_screenshot')
if (getScreenshot) {
  try {
    const norm = normalizeToolSchema(getScreenshot.inputSchema)
    console.log('NORMALIZED get_screenshot:', JSON.stringify(norm).slice(0, 400))
  } catch (e: any) {
    console.log('NORMALIZE FAILED:', e.message)
  }
}
// Screenshot content shape
const shot = await client.callTool('get_screenshot', { nodeId: '4-0' }, undefined)
const shotResult = shot.result as McpCallToolResult | undefined
console.log('SHOT error:', JSON.stringify(shot.error))
console.log('SHOT result keys:', shotResult ? Object.keys(shotResult).join(',') : 'none')
const parts = shotResult?.content ?? []
console.log('SHOT content parts:', parts.length)
for (const p of parts.slice(0, 3)) {
  if (typeof p === 'object' && p !== null) {
    const rec = p as Record<string, unknown>
    console.log('  part type:', rec.type, 'mime:', rec.mimeType, 'dataLen:', typeof rec.data === 'string' ? rec.data.length : 0)
  }
}
