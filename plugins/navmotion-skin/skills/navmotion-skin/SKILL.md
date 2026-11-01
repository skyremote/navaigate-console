---
name: navmotion-skin
description: The NavMotion Skin bb plugin. Use when the user asks to change bb's look, switch skin or palette, go back to the NavAIgate skin, turn the moving background on or off, or use Markdown formatting and the Preview tab in the chat box.
---

# NavMotion Skin

Three skins for bb in the NavMotion film look, a Skin button, and Markdown in the chat box.

## Skins (bb palettes)

| Skin | Id | What moves |
|---|---|---|
| NavMotion Dots | `plugin:navmotion-skin:dots` | A drifting dot ground (pure CSS). Clicks ripple. |
| NavMotion Live | `plugin:navmotion-skin:live` | Dots when idle, flowing silk while the agent in view works, a halo swell when it finishes. A soft focus pull on chat change. |
| NavMotion Tunnel | `plugin:navmotion-skin:tunnel` | Dark mode: outlines growing out of the centre, faster while the agent works. Light mode: halo dots. Plum smoke send button. |

- Switch: the **Skin** button in the sidebar footer, or `bb theme set plugin:navmotion-skin:live`.
- Go back to the NavAIgate skin: `bb theme set plugin:navaigate-skin:navaigate`.
- The palette is server-side: a switch changes bb on every device at once.
- Motion stops on any device set to reduce motion. The layer pauses while bb is hidden.

## Markdown in the chat box

- Live preview while typing, as in Obsidian: bold, italics, strike, inline code, headings, lists, tasks and links show formatted with their markers hidden, and a GFM table shows as a grid. The markers and the table source come back while the caret is in that piece. An unfocused box shows everything rendered.
- Arrow keys step onto the edge of a hidden piece, so the caret never disappears into hidden text. Click a grid to edit its source.
- Pasting table rows with no header or a short divider adds the header row and a full divider, only while the Md button is on and only when every line of the paste is a pipe row. Mixed text, boxed terminal output (`+----+` rules), Paste without formatting, and pastes into or beside an existing table are left exactly as copied.
- The draft stays plain Markdown, so the message renders formatted in the timeline once sent and the agent receives exactly what was typed.
- The **Md** button in the chat box switches live preview on and off (on by default, remembered). The eye button opens the **Preview** tab on the side, which renders the draft live.
- The **+** menu adds a table, a checklist or a heading.
- Live preview needs a bb with the composer live-preview contract (`richText` ranges with `hidden` / `table`, and `transformPaste`). On an older bb the box keeps the coloured markers and the Md button has no visible effect.

## Files

- Skins: `themes/src/base.css` + `themes/src/<skin>.css`, built by `python3 scripts/build-themes.py`.
- Motion layer: `src/engine.ts` (ported from the navmotion film engine), `src/motion-layer.tsx`.
- Skin button: `src/skin-menu.tsx`. Markdown: `src/markdown.tsx` (effects), `src/markdown-live.ts` (constructs, tables, paste repair), `src/live-state.ts` (Md switch). Styles: `app.css`.
