# bloub (vendored)

Source: https://github.com/jeremy-prt/bloub
Commit: `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`
License: MIT (see `LICENSE`, copied verbatim from the source repo)

Not affiliated with x.ai. bloub is an independent, from-scratch SVG recreation
of the x.ai bot avatar, built by Jeremy Perret and measured frame-by-frame off
a reference video; it ships its own MIT license and says so itself.

## What's here

Every non-test file from the upstream `src/bot/` directory, copied verbatim:
`cycles.ts`, `decor.ts`, `engine.ts`, `expressions.ts`, `eyefit.ts`, `face.ts`,
`math.ts`, `profiles.ts`, `repere.ts`, `shape.ts`, `skins.ts`, `states.ts`.

This is the framework-free half of bloub: a pure-TypeScript, dependency-free
animation engine (`BotEngine`, in `engine.ts`) that samples a deterministic
function of time (`sample(t)`) into an SVG-ready frame description (body path,
eye transforms, decorative dots/arcs, notification badge). No Vue, no DOM
access, no i18n. `cycles.ts` (the timeline/cycle-editor model) is vendored for
completeness because the source rule was "every non-test file", but our React
wrapper (`../CoachBot.tsx`) does not use it — we drive individual states
directly, not a scripted cycle.

`src/ui/gaze.ts` (pointer-follow gaze targeting) was deliberately **not**
vendored: `CoachBot` does not expose a `follow` or `gaze` prop, so it isn't
needed, and skipping it keeps this directory to the framework-free engine
only.

## Edits made to vendored files

None. All twelve files are byte-for-byte copies of the upstream source. They
already compile cleanly under this repo's `tsc --noEmit -p .` (verified after
vendoring: 0 new errors, baseline unchanged) — bloub's own `tsconfig.json` is
at least as strict as this repo's (`strict`, `verbatimModuleSyntax`,
`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` all already
on upstream), and none of these files use the `@/*` path alias bloub's own
config defines (all imports here are relative), so nothing needed rewriting.

## Usage

Consumed by `../CoachBot.tsx`, a React port of the parts of upstream's
`src/components/BloubBot.vue` needed for a small state-driven coach avatar
(no timeline/cycle editor, no GIF/video export, no i18n).

## In the Think Better deck (a conference deck)

Copied into this deck from the NavAIgate platform repo `NavAIgate-2.0-event-baseline`
at `392148f1` (the v2 `bot/bloub/` folder), so the coach on S25 is the
platform's own coach. Eleven of the twelve engine files are here, byte for byte,
with `LICENSE` copied verbatim. `cycles.ts` was left out because nothing in the deck
imports it (the platform's `CoachBot.tsx` does not use it either). The React wrapper
is `../CoachBot.tsx`, a trimmed port of the platform's `CoachBot.tsx`.

## In BB (Helper Desk mod)

Copied on 2026-10-24 from an event deck
(its `src/components/coach/` folder), engine files byte for
byte, `LICENSE` verbatim. The wrapper `../CoachBot.tsx` is that deck's file with two default colours
changed to bb theme tokens. Helper Desk uses it as the lead agent's face and as the floating companion.
