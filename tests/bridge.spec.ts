import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Boot the real plugin against the real Paper Desktop MCP server (must be
// running with a file open). Verifies registration, schema normalization,
// live tool execution, and fiber teardown through the plugin's own apply().
describe('dsh-paper-design bridge', () => {
  it('registers paper_* tools and executes get_basic_info live', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(plugin)

    let names: string[] = []
    for (let i = 0; i < 60; i++) {
      names = ctx.tools.schemas().map(s => s.name)
      if (names.length > 0) break
      await sleep(250)
    }

    expect(names.length).toBeGreaterThanOrEqual(33)
    expect(names).toContain('paper_get_basic_info')
    expect(names).toContain('paper_get_screenshot')
    expect(names).toContain('paper_write_html')
    expect(names.every(n => n.startsWith('paper_'))).toBe(true)

    const shot = ctx.tools.schemas().find(s => s.name === 'paper_get_screenshot')
    expect(shot?.parameters).toMatchObject({ type: 'object' })
    expect(JSON.stringify(shot?.parameters)).not.toContain('$schema')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'c1' as never,
      name: 'paper_get_basic_info',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(c => c.type === 'text' ? c.text : '').join('')
    expect(text).toContain('artboards')

    await fiber.dispose()
    expect(ctx.tools.schemas().length).toBe(0)
  }, 60_000)
})
