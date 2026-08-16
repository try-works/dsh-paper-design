// Verify guide injection logic without needing the live runtime: import the
// compiled TS through node type-stripping and exercise buildPaperSystemPromptSuffix.
// Usage: node scripts/verify-injection.mjs
import { readFile } from 'node:fs/promises'

const {
  PAPER_STANDING_MARKER,
  PAPER_GUIDE_MARKER,
  PAPER_GUIDE_INJECT_TURNS,
  buildPaperSystemPromptSuffix,
  extractGuideText,
} = await import('../src/guide.ts')

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log('OK ', name)
  else { console.error('FAIL', name, detail ?? ''); failures++ }
}

check('inject turns is 2', PAPER_GUIDE_INJECT_TURNS === 2)

const standing = buildPaperSystemPromptSuffix({ includeGuide: false, guideText: null })
check('standing-only contains standing marker', standing.includes(PAPER_STANDING_MARKER))
check('standing-only omits guide marker', !standing.includes(PAPER_GUIDE_MARKER))
check('standing-only references get_guide', standing.includes('paper_get_guide'))

const withGuide = buildPaperSystemPromptSuffix({ includeGuide: true, guideText: 'FULL GUIDE BODY' })
check('with-guide contains both markers', withGuide.includes(PAPER_STANDING_MARKER) && withGuide.includes(PAPER_GUIDE_MARKER))
check('with-guide contains body', withGuide.includes('FULL GUIDE BODY'))

const noCache = buildPaperSystemPromptSuffix({ includeGuide: true, guideText: null })
check('no-cache guides to get_guide', noCache.includes('paper_get_guide'))

const extracted = extractGuideText({ content: [{ type: 'text', text: 'guide text here' }, { type: 'image', data: 'x', mimeType: 'image/png' }] })
check('extractGuideText picks first text', extracted === 'guide text here')
check('extractGuideText null on empty', extractGuideText({ content: [] }) === null)

// The index.ts must register the section with the standing order
const index = await readFile('src/index.ts', 'utf8')
check('index imports guide markers', index.includes('buildPaperSystemPromptSuffix') && index.includes('extractGuideText'))
check('index uses order 150', index.includes('STANDING_SECTION_ORDER = 150'))
check('index counts turn/start', index.includes('turn/start'))

if (failures) { console.error(failures, 'failure(s)'); process.exit(1) }
console.log('PASS')
