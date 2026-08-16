/**
 * Paper design guidance: standing rules and the early-turn injected guide.
 *
 * The standing rules are always present in the system prompt while Paper is
 * connected. The full paper-mcp-instructions guide body is injected only for
 * the first {@link PAPER_GUIDE_INJECT_TURNS} agent turns after connect or
 * /paper-reconnect, mirroring the Cursor/pi-paper-design behavior.
 *
 * @module dsh-paper-design/src/guide
 */

/** Section markers (also used by scripts/verify-injection.mjs). */
export const PAPER_STANDING_MARKER = '## Paper Design MCP (standing rules)'
export const PAPER_GUIDE_MARKER = '## Paper Design MCP guide (loaded for early turns this session)'

/** Full guide is appended only for this many agent turns after connect/reconnect. */
export const PAPER_GUIDE_INJECT_TURNS = 2

/**
 * Cursor MCP serverDescription equivalent, adapted to paper_* tool names.
 * Kept verbatim from pi-paper-design except for the turn-count interpolation.
 */
export const PAPER_SERVER_DESCRIPTION = `Paper is a professional design tool for creating user interfaces. The user is working on a 2D canvas composing designs. The Paper MCP bridge gives you paper_* tools to be a talented designer for web and mobile apps and websites. You can read designs from the user's file, understand what the user is currently doing, and write HTML back into the design as new nodes.

**paper_get_guide — use as needed for instructions:**
- Call paper_get_guide({ topic: "paper-mcp-instructions" }) whenever you need the full design-quality / workflow instructions: after the early-turn injected guide is no longer in the system prompt, if the guide text may have been compressed or dropped from context, before a major new design if you are unsure of the rules, or anytime standing rules alone are not enough.
- Call paper_get_guide({ topic: "mobile-status-bar" }) for paste-ready mobile status bar markup.
- Call paper_get_guide({ topic: "figma-import" }) for Figma → Paper import steps.
- Do not skip get_guide when you need it — prefer refreshing instructions over guessing.

The extension injects the full paper-mcp-instructions guide into the system prompt for the first ${PAPER_GUIDE_INJECT_TURNS} agent turns after connect/reconnect (Cursor parity). After that, only these standing rules remain in the system prompt — use paper_get_guide for the full guide as needed.

- Context: call paper_get_basic_info first to understand artboards and dimensions; use paper_get_selection to see user focus.
- Typography: you MUST call paper_get_font_family_info before your first typographic styling in a session. Prefer font families already listed in paper_get_basic_info unless the user specifies otherwise. Use px for font sizes, em for letter-spacing, px for line-height.
- New designs: before writing HTML, generate a brief (palette, type scale, spacing, direction) unless the user provides a design system.
- Creating/editing: each paper_write_html call should add roughly one visual group; prefer paper_duplicate_nodes with paper_update_styles and paper_set_text_content when it is faster than rewriting HTML.
- Quality: use paper_get_screenshot to review after meaningful changes. Artboard height is a starting point — when content clips switch the artboard to height: "fit-content" via paper_update_styles rather than guessing fixed heights.
- Repeated rows (lists, nav): use fixed-width slots for icons and trailing actions (flexShrink: 0); do not rely on gap alone to align columns across rows.
- When done creating or editing, you MUST call paper_finish_working_on_nodes.
- User-facing output: do not include raw node IDs.
- Export to the user's codebase: use paper_get_jsx, paper_get_computed_styles, paper_get_fill_image, etc. for exact values — do not read sizes or colors from screenshots alone.
- Prefer the paper-design skill for the tool reference; standing rules + get_guide (and early-turn injected guide) take precedence for workflow when Paper is connected.`

/** Options controlling one prompt-suffix render. */
export interface PaperPromptOptions {
  /** Append the cached full guide body (early turns). */
  includeGuide: boolean
  /** Cached full guide text, or null when not yet loaded. */
  guideText: string | null
}

/** Build the system-prompt suffix (standing rules always; full guide only when includeGuide). */
export function buildPaperSystemPromptSuffix(options: PaperPromptOptions): string {
  const { includeGuide, guideText } = options
  const parts: string[] = ['', PAPER_STANDING_MARKER, '', PAPER_SERVER_DESCRIPTION.trim(), '']

  if (includeGuide) {
    if (guideText && guideText.trim()) {
      parts.push(PAPER_GUIDE_MARKER, '', guideText.trim(), '')
    } else {
      parts.push(
        PAPER_GUIDE_MARKER,
        '',
        'Guide unavailable from cache. Call paper_get_guide({ topic: "paper-mcp-instructions" }) now for full instructions, or run /paper-reconnect.',
        '',
      )
    }
  } else {
    parts.push(
      '### Paper guide not re-injected this turn',
      '',
      `The full paper-mcp-instructions guide was injected only for the first ${PAPER_GUIDE_INJECT_TURNS} turns after connect/reconnect. Call paper_get_guide({ topic: "paper-mcp-instructions" }) as needed for design-quality rules, review checkpoints, mood/palette guidance, and detailed workflows.`,
      '',
    )
  }
  return parts.join('\n')
}

/**
 * Extract the first text block's text from an MCP tools/call result, used to
 * obtain the paper-mcp-instructions guide body from the get_guide tool.
 * @param result - the raw MCP result object.
 * @returns the guide text, or null when absent.
 */
export function extractGuideText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) return text
    }
  }
  return null
}
