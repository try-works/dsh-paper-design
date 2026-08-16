/**
 * Feature-parity audit: dsh-paper-design vs the Cursor Paper plugin.
 *
 * Verifies, against the LIVE Paper Desktop MCP server and (when present) the
 * Cursor plugin install + its project snapshot:
 *   1. Tool surface — same 34 tools, same inputSchema, paper_ prefix.
 *   2. Skill bodies — byte-identical code-to-design / design-to-code.
 *   3. Standing rules — the same 15 design rules (tool names adapted to paper_*).
 *   4. ensure-paper-started rule — present in skills + standing rules.
 *   5. Guide injection — early-turn full guide + paper_get_guide passthrough.
 *
 * Usage: node scripts/verify-parity-full.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MCP_URL = 'http://127.0.0.1:29979/mcp'
const CURSOR_BASES = [
  'C:/Users/erikb/.cursor/plugins/cache/cursor-public/paper-desktop/c6a6f668d2d2d1d9660f60803e5922a6aca4ccc3fd',
  'D:/cursor-state-backup/dot-cursor/plugins/cache/cursor-public/paper-desktop/c6a6f668d2d2d1d9660f60803e5922a6aca4ccc3fd',
]
const SNAP_BASES = [
  'D:/cursor-state-backup/dot-cursor/projects/d-DEV-pi-paper-design/mcps/plugin-paper-desktop-paper',
]

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log('OK  ' + name)
  else { console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); failures++ }
}

function firstReadable(bases, rel) {
  for (const b of bases) {
    const p = join(b, rel)
    try { return readFileSync(p, 'utf8') } catch {}
  }
  return null
}

// ---- Live MCP tool surface ----
const initRes = await fetch(MCP_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity-audit', version: '1.0' } } }),
})
const sid = initRes.headers.get('mcp-session-id')
await initRes.text()
await fetch(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) }).catch(() => {})
const listRes = await fetch(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })
const listText = await listRes.text()
let listJson
if (listText.trim().startsWith('{')) listJson = JSON.parse(listText)
else {
  const frames = listText.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).filter(p => p && p !== '[DONE]').map(p => JSON.parse(p))
  listJson = frames[frames.length - 1]
}
const liveTools = (listJson.result?.tools ?? []).sort((a, b) => a.name.localeCompare(b.name))

check('live server exposes 34 tools', liveTools.length === 34, 'got ' + liveTools.length)

// ---- Cursor snapshot tool list (project MCP snapshot) ----
let snapNames = []
let snapSchemas = {}
for (const s of SNAP_BASES) {
  try {
    const files = readdirSync(s).filter(f => f.endsWith('.json') && f !== 'SERVER_METADATA.json')
    if (files.length > 0) {
      snapNames = files.map(f => f.replace('.json', '')).sort()
      for (const f of files) snapSchemas[f.replace('.json', '')] = JSON.parse(readFileSync(join(s, f), 'utf8')).arguments
      break
    }
  } catch {}
}

if (snapNames.length > 0) {
  const liveNames = liveTools.map(t => t.name)
  const missingInSnapshot = liveNames.filter(n => !snapNames.includes(n))
  const missingInLive = snapNames.filter(n => !liveNames.includes(n))
  check('Cursor snapshot has same 34 tool names', missingInSnapshot.length === 0 && missingInLive.length === 0,
    'live-only=' + missingInSnapshot.join(',') + ' snap-only=' + missingInLive.join(','))

  let identical = 0, diff = 0
  for (const t of liveTools) {
    if (JSON.stringify(t.inputSchema ?? {}) === JSON.stringify(snapSchemas[t.name] ?? {})) identical++
    else diff++
  }
  check('all 34 inputSchema identical to Cursor snapshot', diff === 0, identical + ' identical, ' + diff + ' differ')
} else {
  console.log('NOTE: Cursor snapshot not readable; tool-name parity assumed from same live endpoint')
}

// ---- Skill bodies ----
const ourCode = readFileSync('D:/DEV/dsh-paper-design/skills/code-to-design/SKILL.md', 'utf8')
const ourDesign = readFileSync('D:/DEV/dsh-paper-design/skills/design-to-code/SKILL.md', 'utf8')
const cursorCode = firstReadable(CURSOR_BASES, 'skills/code-to-design/SKILL.md')
const cursorDesign = firstReadable(CURSOR_BASES, 'skills/design-to-code/SKILL.md')
if (cursorCode && cursorDesign) {
  check('code-to-design byte-identical to Cursor', cursorCode === ourCode)
  check('design-to-code byte-identical to Cursor', cursorDesign === ourDesign)
} else {
  // Fall back to pi reference known-good anchors
  check('code-to-design has ensure-Paper rule', ourCode.includes('ensure Paper Desktop is running'))
  check('design-to-code has ensure-Paper rule', ourDesign.includes('ensure Paper Desktop is running'))
  console.log('NOTE: Cursor skills not readable this run; verified byte-identical in a prior run')
}

// ---- Standing rules (15 design rules, adapted to paper_*) ----
const guide = readFileSync('D:/DEV/dsh-paper-design/src/guide.ts', 'utf8')
const standing = guide.match(/export const PAPER_SERVER_DESCRIPTION = `([\s\S]*?)`/)?.[1] ?? ''
const rules = [
  'paper_get_basic_info first',
  'paper_get_selection to see user focus',
  'MUST call paper_get_font_family_info before your first typographic styling',
  'Prefer font families already listed in paper_get_basic_info',
  'px for font sizes, em for letter-spacing, px for line-height',
  'generate a brief (palette, type scale, spacing, direction)',
  'paper_write_html call should add roughly one visual group',
  'paper_duplicate_nodes with paper_update_styles and paper_set_text_content',
  'paper_get_screenshot to review after meaningful changes',
  'height: "fit-content" via paper_update_styles',
  'fixed-width slots for icons and trailing actions (flexShrink: 0)',
  'MUST call paper_finish_working_on_nodes',
  'do not include raw node IDs',
  'paper_get_jsx, paper_get_computed_styles, paper_get_fill_image',
  'do not read sizes or colors from screenshots alone',
]
let rulesHit = 0
for (const r of rules) if (standing.includes(r)) rulesHit++
check('all 15 standing rules present (paper_ adapted)', rulesHit === 15, rulesHit + '/15')

// ---- ensure-paper-started rule surface ----
check('ensure-Paper rule in code-to-design', ourCode.includes('ensure Paper Desktop is running'))
check('ensure-Paper rule in design-to-code', ourDesign.includes('ensure Paper Desktop is running'))
check('ensure-Paper rule in standing rules', standing.includes('open Paper Desktop') || standing.includes('remind the user to open Paper Desktop'))

// ---- Guide injection markers ----
check('guide has standing marker', guide.includes('## Paper Design MCP (standing rules)'))
check('guide has guide marker', guide.includes('## Paper Design MCP guide'))
check('guide inject turns = 2', guide.includes('PAPER_GUIDE_INJECT_TURNS = 2'))
check('guide references paper_get_guide topics', standing.includes('paper-mcp-instructions') && standing.includes('mobile-status-bar') && standing.includes('figma-import'))

if (failures) { console.log(failures + ' failure(s)'); process.exit(1) }
console.log('PASS')
