# dsh-paper-design

Paper Design MCP bridge as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle.

Connects to the **Paper Desktop** MCP server (`http://127.0.0.1:29979/mcp`), registers every Paper tool as a native `paper_*` tool with image screenshot support, injects Cursor-parity design guidance, registers the Paper skills, and exposes `/paper-reconnect`.

## What it provides

- **`paper_*` tools** — every tool advertised by Paper Desktop MCP (`get_basic_info`, `get_screenshot`, `write_html`, `update_styles`, …), registered natively on `ctx.tools`. Raw MCP `inputSchema`s are normalized to the enforced DSH JSON-Schema subset (`$schema`/`format`/`pattern`/`propertyNames`/`min*`/`max*` stripped, `anyOf`→`oneOf`).
- **Image screenshot forwarding** — `get_screenshot` image blocks are decoded and durably committed through `ctx.attachments` (`saveImage`), then emitted as attachment-backed image blocks (and deferred as plugin-sourced context for nested `run_code` dispatches), so screenshots reach image-capable models.
- **Cursor-parity guidance** — standing rules injected as a system-prompt section (order 150), plus the full `paper-mcp-instructions` guide injected for the first 2 agent turns after connect/reconnect. `paper_get_guide` also caches the guide body.
- **Skills** — `code-to-design`, `design-to-code` (Cursor Paper plugin bodies verbatim), and `paper-design` (progressive-disclosure tool reference index).
- **`/paper-reconnect`** — re-initializes the MCP session, clears the guide cache, and resets the early-turn guide-injection budget.

## Requirements

- **Paper Desktop** running with a file open (the MCP server lives inside the desktop app).
- A DeepSeek Harness profile that bundles `@deepseek-ai/dsh-base` (or the services it mounts): `tools`, `systemPrompt`, `attachments` (for images), `skills`, `commands`, `llm`.
- An image-capable model route for screenshot support (text tools work on any route).

## Install

Add this package to the profile and its `bundles` list, e.g. in `~/.dsh/profiles/<name>/package.json`:

```json
{
  "dependencies": {
    "dsh-paper-design": "link:D:/DEV/dsh-paper-design"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-paper-design"
      ]
    }
  }
}
```

Then `pnpm install` in the profile and restart the running DSH process. The bridge imports its `src/index.ts` directly through the loader bundle path (no build required), mirroring `dsh-recursive-mode`.

> Restart is required for host/bundle changes: the web client-plugin HMR only rebuilds the web shell, not host plugins.

## Usage

- Ask the agent to read or design in Paper; it will use `paper_get_basic_info`, `paper_open_file`, `paper_get_screenshot`, and the rest.
- `/paper-reconnect` re-syncs after restarting Paper Desktop.

## Development

```bash
pnpm install
pnpm run build                        # type-check (tsc -p tsconfig.build.json)
pnpm run verify                       # live MCP bridge verification (needs Paper Desktop)
pnpm run verify:bridge                # in-process plugin boot + live paper_get_basic_info
pnpm run verify:parity                # Cursor/pi skill-body parity
pnpm run verify:injection             # prompt-section marker/budget logic
pnpm test                             # everything above
```

## Layout

- `src/index.ts` — bundle entry: connect, normalize, register tools + prompt + skills + command.
- `src/mcp-client.ts` — minimal Streamable HTTP MCP client (initialize/tools-list/tools-call, session tracking, SSE parsing, one-shot re-init).
- `src/schema.ts` — raw Paper JSON Schema → enforced DSH subset normalizer.
- `src/guide.ts` — standing rules + early-turn guide markers and builder.
- `src/skills.ts` — runtime skill registrations.
- `skills/*/SKILL.md` — on-disk skill bodies (parity artifacts).
- `cordis.patch.yml` — loader patch inserting the bridge into a `cordis:group` realm.

## License

MIT