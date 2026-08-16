// Parity verification against the Cursor Paper plugin skills + pi reference.
// Usage: node scripts/verify-parity.mjs
import { readFile, access } from 'node:fs/promises'

const CURSOR_BASE = 'C:/Users/erikb/.cursor/plugins/cache/cursor-public/paper-desktop/c6a6f668d2d1d9660f60803e5922a6aca4ccc3fd'

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log('OK ', name)
  else { console.error('FAIL', name, detail ?? ''); failures++ }
}

// Our on-disk skill bodies
const ourCode = await readFile('skills/code-to-design/SKILL.md', 'utf8')
const ourDesign = await readFile('skills/design-to-code/SKILL.md', 'utf8')

check('code-to-design has frontmatter name', /^---\s*\nname: code-to-design\s*\n/.test(ourCode))
check('code-to-design has ensure-Paper line', ourCode.includes('ensure Paper Desktop is running with a file open'))
check('design-to-code has frontmatter name', /^---\s*\nname: design-to-code\s*\n/.test(ourDesign))
check('design-to-code has ensure-Paper line', ourDesign.includes('ensure Paper Desktop is running with a file open'))

// Cursor reference bodies (if present)
const cursorCode = await exists(CURSOR_BASE + '/skills/code-to-design/SKILL.md')
const cursorDesign = await exists(CURSOR_BASE + '/skills/design-to-code/SKILL.md')
if (cursorCode && cursorDesign) {
  const cc = await readFile(CURSOR_BASE + '/skills/code-to-design/SKILL.md', 'utf8')
  const cd = await readFile(CURSOR_BASE + '/skills/design-to-code/SKILL.md', 'utf8')
  check('code-to-design body matches Cursor', cc.trim() === ourCode.trim())
  check('design-to-code body matches Cursor', cd.trim() === ourDesign.trim())
} else {
  console.log('NOTE: Cursor plugin skills not found; skipped verbatim body comparison')
}

// pi reference standing rules presence
const pi = await readFile('D:/DEV/pi-paper-design/extensions/paper-mcp.ts', 'utf8')
check('pi standing rules: get_guide topics', pi.includes('mobile-status-bar') && pi.includes('figma-import'))
check('pi standing rules: typography units', pi.includes('px') && pi.includes('em'))

// our guide module carries the same anchors
const guide = await readFile('src/guide.ts', 'utf8')
check('guide has standing marker', guide.includes('## Paper Design MCP (standing rules)'))
check('guide has guide marker', guide.includes('## Paper Design MCP guide (loaded for early turns this session)'))
check('guide inject turns = 2', guide.includes('PAPER_GUIDE_INJECT_TURNS = 2'))

if (failures) { console.error(failures, 'failure(s)'); process.exit(1) }
console.log('PASS')
