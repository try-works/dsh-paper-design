---
name: paper-design
description: Use when designing in Paper via paper_* tools. Progressive disclosure index of the paper-mcp-instructions guide plus tool reference and HTML rules.
---

# Paper Design (MCP)

Use this skill for **tool reference** when working with Paper via the DSH bridge. All tools are prefixed `paper_`. Paper Desktop must be running with a file open.

## Guidance sources

| Source | Role |
|--------|------|
| System prompt injection | Standing rules every turn; full `paper-mcp-instructions` guide for the first turns after connect/reconnect |
| `paper_get_guide` | Load full guide topics as needed: `paper-mcp-instructions`, `mobile-status-bar`, `figma-import` |
| This skill | Tool tables + index of every guide section |

Load the full guide when a topic below applies: `paper_get_guide({ topic: "paper-mcp-instructions" })`.

## Indexed guide sections

1. Review Checkpoints (MANDATORY) — screenshot after each section; spacing/typography/contrast/alignment/artboard-fit/repetition.
2. Design Quality — minimalism, warm human touch, spacing rhythm, asymmetry, hierarchy, playful register, default light mode.
3. Mood word & scene-derived color — commit to a mood word before hex.
4. Proven background × accent pairings.
5. Pairings to avoid.
6. Neutrals.
7. Secondary accents.
8. Text contrast & tiny type.
9. Vague / capability-test prompts.
10. Placeholder content — Paper only, never Figma/Sketch.
11. Vertical lane alignment — fixed-width slots + flexShrink:0.
12. Before creating new designs — post a design brief first.
13. Workflow tips — write small, write often.
14. Context & exploration steps — get_basic_info → tokens → selection → tree → screenshot → jsx → computed styles.
15. Writing new designs.
16. Editing existing designs.
17. Design → codebase — exact values from jsx/computed styles.
18. Fonts — get_font_family_info before first typographic styling.
19. Typographic units — px font-size, em letter-spacing, px line-height.
20. Figma import — `paper_get_guide({ topic: "figma-import" })`.
21. Mobile status bar — `paper_get_guide({ topic: "mobile-status-bar" })`.

## Quick start

1. `paper_list_files` → 2. `paper_open_file` → 3. `paper_get_basic_info` → 4. `paper_get_selection`.

## Tool reference (see full skill for tables)

Navigation: `paper_list_files`, `paper_open_file`, `paper_create_file`, `paper_create_page`.
Read: `paper_get_basic_info`, `paper_get_selection`, `paper_get_node_info`, `paper_get_children`, `paper_get_tree_summary`, `paper_get_screenshot`, `paper_get_jsx`, `paper_get_computed_styles`, `paper_get_fill_image`, `paper_find_nodes`, `paper_get_font_family_info`, `paper_get_guide`.
Comments: `paper_list_comment_threads`, `paper_get_comment_thread`, `paper_list_comment_thread_authors`, `paper_set_comment_thread_status`.
Write/edit: `paper_write_html`, `paper_create_artboard`, `paper_set_text_content`, `paper_rename_nodes`, `paper_duplicate_nodes`, `paper_move_nodes`, `paper_update_styles`, `paper_delete_nodes`, `paper_finish_working_on_nodes`.
Tokens: `paper_get_tokens`, `paper_create_tokens`, `paper_set_tokens`.
Export: `paper_export`, `paper_export_combined_pdf`.

## HTML rules for paper_write_html

- Incremental: one visual item per call.
- Clone: `<x-paper-clone node-id="A-01" style="..." />`.
- Inline styles; tokens as `var(--color-primary)`.
- Flex + padding + gap, not margin; no grid/tables.
- `layer-name` attribute; `paper-asset:///absolute/path` for local images.
- No emoji icons — SVG or images.

## Connection

Paper Desktop with a file open. `/paper-reconnect` refreshes MCP session, guide cache, and early-turn injection budget.
