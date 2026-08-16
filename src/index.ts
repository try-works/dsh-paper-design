/**
 * dsh-paper-design bundle entry: the Paper MCP bridge.
 *
 * Connects to the Paper Desktop MCP server (http://127.0.0.1:29979/mcp),
 * registers every Paper tool as a native `paper_*` tool with image-content
 * support (screenshots reach the model as durable attachment-backed image
 * blocks), injects Cursor-parity standing rules and the early-turn full
 * guide, registers the paper skills, and exposes /paper-reconnect.
 *
 * @module dsh-paper-design/src/index
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports activate the cordis Context augmentations below (services
// are read via ctx.get at runtime; only the augmentation is needed for types).
import type {} from '@deepseek-ai/dsh-commands'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-skill'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { PaperMcpClient, MCP_URL, type McpCallToolResult, type McpContentPart } from './mcp-client.ts'
import { normalizeToolSchema } from './schema.ts'
import {
  PAPER_GUIDE_INJECT_TURNS,
  buildPaperSystemPromptSuffix,
  extractGuideText,
} from './guide.ts'
import { applySkills } from './skills.ts'

export const name = 'dsh-paper-design'
export const inject = ['tools', 'systemPrompt']

/** Deterministic bridge name to source injected image context. */
const PLUGIN_SOURCE = 'dsh-paper-design'

/** Prompt section order inside the tool-guidance band (100–199). */
const STANDING_SECTION_ORDER = 150

/** Prefix every registered Paper tool. */
const TOOL_PREFIX = 'paper_'

/** Never bridge an auth tool even if the server starts advertising one. */
const FILTERED_TOOLS = new Set(['mcp_auth'])

/** Image media types the Paper server emits; must intersect attachment limits. */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

interface PaperToolInfo {
  rawName: string
  publicName: string
  description: string
  parameters: Record<string, unknown>
}

interface BridgeState {
  client: PaperMcpClient
  tools: PaperToolInfo[]
  guideText: string | null
  /** Remaining turns (counted at agent running transitions) that receive the full guide. */
  injectTurnsLeft: number
  /** Turn-count per session id, for the per-step assembly read. */
  sessionTurns: Map<string, number>
  toolDisposers: Array<() => void>
}

/** Total the session/event feed to count turn starts per session. */
function countTurnStarts(state: BridgeState, sessionId: string, event: { type?: string }): void {
  if (event.type !== 'turn/start') return
  const current = state.sessionTurns.get(sessionId) ?? 0
  state.sessionTurns.set(sessionId, current + 1)
}

/** Whether the full guide should be included for one agent assembly. */
function includeGuideFor(state: BridgeState, agentId: string): boolean {
  if (state.injectTurnsLeft <= 0) return false
  const turns = state.sessionTurns.get(agentId) ?? 0
  return turns < PAPER_GUIDE_INJECT_TURNS
}

/**
 * Render an MCP result into model content blocks, forwarding images through
 * the attachment store when one is mounted. Returns the blocks plus the
 * structured content (unmodified) for the canonical value.
 */
async function renderMcpResult(
  state: BridgeState,
  exec: ToolRunContext,
  rawName: string,
  result: McpCallToolResult,
  attachments: AttachmentStore | undefined,
): Promise<{ blocks: ContentBlock[]; structured?: JsonValue }> {
  const parts = result.content ?? []
  const blocks: ContentBlock[] = []
  const textParts: string[] = []

  for (const part of parts) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
    const block = part as McpContentPart
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
      continue
    }
    if (block.type === 'image') {
      const mime = (block as { mimeType?: unknown }).mimeType
      const data = (block as { data?: unknown }).data
      if (typeof data !== 'string' || data.length === 0) {
        textParts.push(`[image: ${typeof mime === 'string' ? mime : 'unknown'}, content discarded]`)
        continue
      }
      if (attachments === undefined) {
        textParts.push(`[image: ${typeof mime === 'string' ? mime : 'unknown'}, content discarded (no attachment store)]`)
        continue
      }
      const mediaType = typeof mime === 'string' ? IMAGE_MEDIA_TYPES[mime.toLowerCase()] : undefined
      if (mediaType === undefined) {
        textParts.push(`[image: ${typeof mime === 'string' ? mime : 'unknown'}, unsupported media type]`)
        continue
      }
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        textParts.push(`[image: ${mediaType}, not accepted by this deployment]`)
        continue
      }
      try {
        const bytes = Buffer.from(data, 'base64')
        const ref = await attachments.saveImage({ data: bytes, mediaType, name: `${rawName}.${mediaType.split('/')[1] ?? 'img'}` })
        blocks.push({ type: 'image', attachment: ref })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        textParts.push(`[image: ${mediaType}, failed to attach: ${message}]`)
      }
      continue
    }
    // Fall through for resource/audio/unknown: emit a compact note.
    textParts.push(`[${(block.type as string) ?? 'unknown'}: content discarded]`)
  }

  if (textParts.length > 0) blocks.unshift({ type: 'text', text: textParts.join('\n') })
  const structured = typeof result.structuredContent === 'object' && result.structuredContent !== null && !Array.isArray(result.structuredContent)
    ? result.structuredContent as JsonValue
    : undefined
  return { blocks, structured }
}

/** One registerable raw ToolDefinition for a Paper tool. */
function createToolDefinition(
  state: BridgeState,
  info: PaperToolInfo,
  withAttachments: (fn: (attachments: AttachmentStore | undefined) => Promise<void>) => Promise<void>,
): ToolDefinition {
  const { rawName, publicName, description, parameters } = info

  return {
    name: publicName,
    description: `[Paper Design MCP] ${description}`.trim(),
    parameters,
    output: {
      // Canonical value: the full MCP result (text content, structuredContent),
      // projected through the enforced subset. Images render as attachment refs.
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: JsonValue): ContentBlock[] {
        // Re-render the canonical value; images are represented by refs in
        // content when they were attachable, and text is re-joined.
        const record = (value ?? {}) as { content?: JsonValue[]; structuredContent?: JsonValue }
        const textParts: string[] = []
        for (const entry of record.content ?? []) {
          if (typeof entry === 'string') { textParts.push(entry); continue }
          if (entry !== null && typeof entry === 'object' && (entry as Record<string, unknown>).text !== undefined) {
            textParts.push(String((entry as Record<string, unknown>).text))
            continue
          }
        }
        const blocks: ContentBlock[] = []
        if (textParts.length > 0) blocks.unshift({ type: 'text', text: textParts.join('\n') })
        if (record.structuredContent !== undefined) {
          blocks.push({ type: 'text', text: JSON.stringify(record.structuredContent, null, 2) })
        }
        return blocks
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      // Raw registrations receive unvalidated args; coerce to a plain record.
      const record = (typeof args === 'object' && args !== null && !Array.isArray(args)) ? args as Record<string, unknown> : {}
      const response = await state.client.callTool(rawName, record, exec.signal)
      if (response.error) {
        throw new Error(`paper_${rawName}: ${response.error.message}`)
      }
      const result = response.result as McpCallToolResult | undefined
      if (result === undefined) {
        throw new Error(`paper_${rawName}: empty MCP result`)
      }
      if (result.isError === true) {
        throw new Error(`paper_${rawName}: MCP error`)
      }
      // Capture guide text early so get_guide populates the cache.
      if (rawName === 'get_guide') {
        const guide = extractGuideText(result)
        if (guide !== null) state.guideText = guide
      }
      let blocks: ContentBlock[] = []
      await withAttachments(async (attachments) => {
        const rendered = await renderMcpResult(state, exec, rawName, result, attachments)
        blocks = rendered.blocks
      })
      // Defer image context to the parent agent when nested (composite/run_code).
      if (exec.parent !== undefined && blocks.length > 0) {
        exec.deferContext(createUserMessage({
          content: blocks,
          source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
        }))
      }
      // Canonical value mirrors the MCP content; text blocks stored as strings.
      const content = (result.content ?? []).map((part): JsonValue => {
        if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
          return String((part as { text?: unknown }).text ?? '')
        }
        if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image') {
          return { type: 'image', note: 'attachment-forwarded' }
        }
        return null
      })
      return {
        content,
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent as JsonValue } : {}),
      }
    },
  }
}

/** Resolve the attachment store via runtime ctx.get, if mounted. */
function resolveAttachments(ctx: Context): AttachmentStore | undefined {
  const attachments = ctx.get('attachments')
  if (attachments === undefined || typeof (attachments as { saveImage?: unknown }).saveImage !== 'function') return undefined
  return attachments as AttachmentStore
}

/**
 * Apply the bridge: connect, discover tools, register them + prompt + skills.
 * Registration is gated on the attachment store only for the image-capable
 * execution path; the core tools always register so text workflows work even
 * without a mounted attachment store.
 */
export function apply(ctx: Context) {
  ctx.effect(async function* () {
    const client = new PaperMcpClient(MCP_URL)
    const state: BridgeState = {
      client,
      tools: [],
      guideText: null,
      injectTurnsLeft: PAPER_GUIDE_INJECT_TURNS,
      sessionTurns: new Map(),
      toolDisposers: [],
    }

    const initialize = await client.initialize()
    if (initialize.error) {
      ctx.logger('dsh-paper-design').warn(`Paper MCP unavailable at ${MCP_URL}: ${initialize.error.message}`)
      yield () => {}
      return
    }

    const listed = await client.listTools()
    if (listed.error) {
      ctx.logger('dsh-paper-design').warn(`Paper tools/list failed: ${listed.error.message}`)
      yield () => {}
      return
    }

    const rawTools = (listed.result as { tools?: unknown } | undefined)?.tools
    const toolInfos: PaperToolInfo[] = []
    if (Array.isArray(rawTools)) {
      for (const raw of rawTools) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry = raw as { name?: unknown; description?: unknown; inputSchema?: unknown }
        if (typeof entry.name !== 'string' || FILTERED_TOOLS.has(entry.name)) continue
        if (!/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue
        const publicName = `${TOOL_PREFIX}${entry.name}`
        const description = typeof entry.description === 'string' ? entry.description : entry.name
        const parameters = normalizeToolSchema(entry.inputSchema) as unknown as Record<string, unknown>
        toolInfos.push({ rawName: entry.name, publicName, description, parameters })
      }
    }
    state.tools = toolInfos

    // Prompt section: standing rules always; full guide for early turns.
    const sectionDisposer = ctx.systemPrompt.section({
      name: 'paper-design:standing',
      order: STANDING_SECTION_ORDER,
      text: (context) => {
        const agentId = (context as { agent?: { id?: string } }).agent?.id
        const includeGuide = agentId !== undefined && includeGuideFor(state, agentId)
        return buildPaperSystemPromptSuffix({
          includeGuide,
          guideText: state.guideText,
        })
      },
    })

    // Observe session/event (global) to count turn starts per session id.
    const sessionObserver = ctx.on('session/event', (session, event) => {
      if (typeof (session as { id?: unknown }).id === 'string') {
        countTurnStarts(state, (session as { id: string }).id, event)
      }
    }, { global: true })

    // Register tools through the tools service; image path uses ctx.get at
    // runtime so a late-mounted attachment store is honored.
    const withAttachments = async (fn: (attachments: AttachmentStore | undefined) => Promise<void>) => {
      const attachments = resolveAttachments(ctx)
      await fn(attachments)
    }
    for (const info of toolInfos) {
      const definition = createToolDefinition(state, info, withAttachments)
      try {
        state.toolDisposers.push(ctx.tools.register(definition))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger('dsh-paper-design').warn(`failed to register ${info.publicName}: ${message}`)
      }
    }

    // Register skills.
    const skillsDisposer = applySkills(ctx)

    // /paper-reconnect command.
    const commandDisposer = ctx.commands.register({
      name: 'paper-reconnect',
      description: 'Reconnect to the Paper Desktop MCP server and refresh guide cache + early-turn injection budget.',
      handler: async () => {
        const init = await client.initialize()
        if (init.error) return { kind: 'error', text: `Paper MCP reconnect failed: ${init.error.message}` }
        const listedAgain = await client.listTools()
        if (listedAgain.error) return { kind: 'error', text: `Paper MCP tools/list failed: ${listedAgain.error.message}` }
        state.guideText = null
        state.injectTurnsLeft = PAPER_GUIDE_INJECT_TURNS
        state.sessionTurns.clear()
        return { kind: 'success', text: 'Paper MCP reconnected; guide cache and injection budget refreshed.' }
      },
    })

    yield () => {
      for (const dispose of state.toolDisposers) dispose()
      skillsDisposer()
      commandDisposer()
      sectionDisposer()
      sessionObserver()
    }
  })
}
