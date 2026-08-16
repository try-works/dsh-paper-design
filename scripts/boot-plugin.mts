// In-process boot of the dsh-paper-design plugin against the live Paper MCP server.
// Usage: node scripts/boot-plugin.mts
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
const fiber: any = await ctx.plugin(plugin)

// apply() runs an async generator effect; poll until paper_* tools appear.
let names: string[] = []
for (let i = 0; i < 60; i++) {
  names = ctx.tools.schemas().map(s => s.name)
  if (names.length > 0) break
  await sleep(250)
}
console.log('REGISTERED:', names.length)
console.log('HAS basic:', names.includes('paper_get_basic_info'))
console.log('HAS shot:', names.includes('paper_get_screenshot'))
console.log('HAS write:', names.includes('paper_write_html'))
console.log('ALL PREFIXED:', names.every(n => n.startsWith('paper_')))
const sample = ctx.tools.schemas().find(s => s.name === 'paper_get_screenshot')
console.log('SHOT SCHEMA:', JSON.stringify(sample?.parameters).slice(0, 300))

if (names.length === 0) {
  console.error('FAIL: no tools registered')
  process.exit(1)
}

const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: 'c1',
  name: 'paper_get_basic_info',
  arguments: {},
})
console.log('EXEC isError:', result.isError)
const text = result.content.map(c => c.type === 'text' ? c.text : '').join('')
console.log('EXEC text len:', text.length)
console.log('EXEC has artboards:', text.includes('artboards'))

// Auth manager must boot without touching the network (Paper Desktop exposes
// no OAuth discovery today) and report unauthenticated.
await sleep(300)
const state: any = fiber
// The fiber is the plugin's applied context wrapper; the auth manager lives on
// the closure state. Poll via a status surface instead: check the plugin
// registered the auth commands by invoking the command service indirectly is
// overkill — assert the observable: no tokens file was created and the plugin
// booted cleanly. The auth path itself is covered by verify-auth.mts.
const home = process.env.DSH_HOME ?? process.env.USERPROFILE + '/.dsh'
const fs = await import('node:fs')
const storeExists = fs.existsSync(home + '/paper-design/oauth.json')
console.log('AUTH store absent on unauthenticated boot:', !storeExists)

await fiber.dispose()
console.log('DISPOSED OK; tools after dispose:', ctx.tools.schemas().length)
